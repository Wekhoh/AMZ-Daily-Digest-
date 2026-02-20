import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { collectWeAreSellers } from './collectors/wearesellers.js';
import { collectRSS } from './collectors/rss.js';
import { collectReddit } from './collectors/reddit.js';
import { collectSellerCentral } from './collectors/sellercentral.js';
import { processArticles } from './process.js';
import {
  getExistingUrls,
  getFallbackArticlesForDigest,
  upsertArticles,
  saveDigest,
  getDigestByDate,
  acquireRunLock,
  markRunSent,
  markRunFailed,
  markRunSkipped,
  getRecentRuns,
  getActiveSubscribers,
  saveDigestDeliveries,
} from './store.js';
import { generateEmailHtml, sendDigestEmail, sendAlertEmail } from './email.js';
import type { Article } from './store.js';
import { canonicalizeUrl } from './utils.js';
import { AI } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEARESELLERS_MIN_ARTICLES = 5;

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function elapsed(start: number): string {
  return ((Date.now() - start) / 1_000).toFixed(1);
}

function normalizeAndDedupeUrls(articles: Article[]): {
  articles: Article[];
  dropped: number;
} {
  const seen = new Set<string>();
  const deduped: Article[] = [];
  let dropped = 0;

  for (const article of articles) {
    const rawUrl = article.raw_url ?? article.url;
    const canonical = canonicalizeUrl(rawUrl) ?? rawUrl;
    if (seen.has(canonical)) {
      dropped++;
      continue;
    }
    seen.add(canonical);
    deduped.push({
      ...article,
      raw_url: rawUrl,
      canonical_url: canonical,
      // Keep outbound link clean and stable.
      url: canonical,
    });
  }

  return { articles: deduped, dropped };
}

function dedupeByUrl(articles: Article[]): Article[] {
  const seen = new Set<string>();
  const deduped: Article[] = [];

  for (const article of articles) {
    const key = article.canonical_url ?? article.url;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(article);
  }

  return deduped;
}

async function ensureDigestWindow(
  date: string,
  selected: Article[],
): Promise<Article[]> {
  const initial = dedupeByUrl(selected).slice(0, AI.MAX_ARTICLES);
  if (initial.length >= AI.MIN_ARTICLES) {
    return initial;
  }

  const needed = AI.MIN_ARTICLES - initial.length;
  const fallbackLimit = Math.min(AI.MAX_ARTICLES * 3, needed * 4);
  const fallbackPool = await getFallbackArticlesForDigest({
    limit: fallbackLimit,
    minScore: AI.RELAXED_MIN_SCORE,
    excludeUrls: initial.map((item) => item.canonical_url ?? item.url),
  });

  const merged = dedupeByUrl(
    [...initial, ...fallbackPool].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
  ).slice(0, AI.MAX_ARTICLES);

  if (merged.length < AI.MIN_ARTICLES) {
    const message =
      `[Main] Final digest for ${date} below minimum: ${merged.length}/${AI.MIN_ARTICLES} ` +
      `(fallback candidates=${fallbackPool.length})`;
    await sendAlertEmail(`${message}\n请检查采集源稳定性、去重与筛选阈值。`);
    throw new Error(`${message} — aborting send`);
  }

  if (merged.length > initial.length) {
    console.log(
      `[Main] Topped up digest with ${merged.length - initial.length} fallback articles ` +
      `(from history pool ${fallbackPool.length})`,
    );
  }

  return merged;
}

async function releaseSentRunLockForRepair(
  date: string,
  existingCount: number,
): Promise<void> {
  const repairReason =
    `Auto-repair requested: existing digest for ${date} below minimum ` +
    `(${existingCount}/${AI.MIN_ARTICLES})`;

  try {
    const recentRuns = await getRecentRuns(60);
    const sentRun = recentRuns.find(
      (run) => run.digest_date === date && run.status === 'sent',
    );

    if (!sentRun) {
      console.warn(
        `[Main] ${repairReason}. No sent run lock found in recent runs; will attempt lock acquisition directly.`,
      );
      return;
    }

    await markRunFailed(sentRun.run_id, repairReason);
    console.log(
      `[Main] Released previous sent run lock ${sentRun.run_id} for ${date}; starting repair run.`,
    );
  } catch (err) {
    console.warn(
      `[Main] Failed to release sent run lock for ${date}; repair may be blocked by idempotency lock.`,
      err,
    );
  }
}

/**
 * Fail-fast: validate all required env vars at startup.
 * Prevents wasting 2+ minutes on scraping only to crash at email/DB step.
 */
function validateConfig(): void {
  const required = [
    'GEMINI_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_KEY',
    'GMAIL_USER',
    'GMAIL_APP_PASSWORD',
    'DIGEST_EMAIL',
    'WEARESELLERS_COOKIES',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

/**
 * Run a collector with error isolation.
 * If a collector throws, log the error and return empty — never crash the pipeline.
 */
async function safeCollect(
  name: string,
  fn: () => Promise<Article[]>
): Promise<Article[]> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[Main] Collector "${name}" failed:`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runPipeline(): Promise<void> {
  const startTime = Date.now();
  const date = today();
  const runId = randomUUID();
  let emailSent = false;
  let sentArticleCount = 0;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  AMZ Daily Digest — ${date}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    // ------------------------------------------------------------------
    // Step 0: Validate configuration + idempotency guard
    // ------------------------------------------------------------------
    validateConfig();
    const existingDigest = await getDigestByDate(date);
    const existingCount = existingDigest?.article_count ?? 0;
    const shouldRepairExistingDigest =
      Boolean(existingDigest) && existingCount < AI.MIN_ARTICLES;

    if (shouldRepairExistingDigest) {
      console.warn(
        `[Main] Existing digest for ${date} is below minimum: ${existingCount}/${AI.MIN_ARTICLES}. ` +
        'Attempting auto-repair run.',
      );
      await releaseSentRunLockForRepair(date, existingCount);
    }

    const lockAcquired = await acquireRunLock(date, runId);
    if (!lockAcquired) {
      if (shouldRepairExistingDigest) {
        console.log(
          `[Main] Lock not acquired for ${date} during repair attempt. Another run is active or sent lock was not releasable.`,
        );
      } else {
        console.log(
          `[Main] Lock not acquired for ${date}. Another run is active or digest already sent. Skipping.`,
        );
      }
      return;
    }

    if (existingDigest && !shouldRepairExistingDigest) {
      await markRunSkipped(runId, `Digest already exists for ${date}`);
      console.log(
        `[Main] Digest for ${date} already sent (${existingDigest.article_count} articles). Skipping.`
      );
      return;
    }

    // ------------------------------------------------------------------
    // Step 1: Parallel collection from all sources
    // ------------------------------------------------------------------
    console.log('[Main] Step 1/5: Collecting articles from all sources...');

    const [wearesellersArticles, rssArticles, redditArticles, sellerCentralArticles] =
      await Promise.all([
        safeCollect('wearesellers', collectWeAreSellers),
        safeCollect('rss', collectRSS),
        safeCollect('reddit', collectReddit),
        safeCollect('sellercentral', collectSellerCentral),
      ]);

    // Alert if WeAreSellers (P0 source) returned too few — likely cookie expired or scraping degraded
    if (wearesellersArticles.length < WEARESELLERS_MIN_ARTICLES) {
      const msg = wearesellersArticles.length === 0
        ? '知无不言采集返回 0 篇文章，Cookie 可能已过期。'
        : `知无不言仅采集到 ${wearesellersArticles.length} 篇文章（正常应 20+），页面结构可能变化或 Cookie 即将过期。`;
      console.warn(`[Main] ${msg}`);
      try {
        await sendAlertEmail(`${msg}\n请检查并更新 WEARESELLERS_COOKIES secret。`);
      } catch (alertErr) {
        console.error('[Main] Failed to send alert email:', alertErr);
      }
    }

    const allRaw: Article[] = [
      ...wearesellersArticles,
      ...rssArticles,
      ...redditArticles,
      ...sellerCentralArticles,
    ];

    console.log(
      `[Main] Collected ${allRaw.length} raw articles ` +
        `(知无不言: ${wearesellersArticles.length}, AMZ123: ${rssArticles.length}, ` +
        `Reddit: ${redditArticles.length}, SellerCentral: ${sellerCentralArticles.length})`
    );

    if (allRaw.length === 0) {
      await markRunSkipped(runId, 'No articles collected from any source');
      console.warn('[Main] No articles collected from any source. Exiting.');
      return;
    }

    // ------------------------------------------------------------------
    // Step 2: Deduplicate against existing URLs in database
    // ------------------------------------------------------------------
    console.log('[Main] Step 2/5: Deduplicating...');

    const normalized = normalizeAndDedupeUrls(allRaw);
    const urls = normalized.articles.map((a) => a.canonical_url ?? a.url);
    const existingUrls = await getExistingUrls(urls);
    const newArticles = normalized.articles.filter(
      (a) => !existingUrls.has(a.canonical_url ?? a.url),
    );

    console.log(
      `[Main] ${newArticles.length} new articles ` +
      `(${normalized.dropped} batch duplicates, ` +
      `${normalized.articles.length - newArticles.length} DB duplicates removed)`
    );

    if (newArticles.length === 0) {
      await markRunSkipped(runId, 'All articles were duplicates');
      console.log('[Main] All articles are duplicates. Exiting.');
      return;
    }

    // ------------------------------------------------------------------
    // Step 3: AI processing — score, summarize, categorize
    // ------------------------------------------------------------------
    console.log('[Main] Step 3/5: AI processing...');

    const processed = await processArticles(newArticles);

    console.log(`[Main] ${processed.length} articles passed AI scoring (>= 6)`);

    if (processed.length === 0) {
      await markRunSkipped(runId, 'No articles passed AI relevance threshold');
      console.log('[Main] No articles passed the relevance threshold. Exiting.');
      return;
    }

    const finalArticles = await ensureDigestWindow(date, processed);
    sentArticleCount = finalArticles.length;

    // ------------------------------------------------------------------
    // Step 4: Generate and send digest email (BEFORE storing to DB)
    // If email fails, this run is marked failed. If post-send persistence fails,
    // run remains "sent" to prevent duplicate delivery on retry.
    // ------------------------------------------------------------------
    console.log('[Main] Step 4/5: Generating and sending email...');

    const emailHtml = generateEmailHtml(finalArticles, date);
    const subscribers = await getActiveSubscribers();
    const fallbackRecipient = process.env.DIGEST_EMAIL?.trim();
    const recipients = subscribers.length > 0
      ? subscribers.map((s) => s.email)
      : (fallbackRecipient ? [fallbackRecipient] : []);

    if (recipients.length === 0) {
      throw new Error('No recipients configured (subscribers table empty and DIGEST_EMAIL missing)');
    }

    const digestSendResult = await sendDigestEmail(emailHtml, date, recipients);
    emailSent = true;

    if (subscribers.length > 0) {
      const subscriberByEmail = new Map(
        subscribers.map((s) => [s.email, s.id] as const),
      );

      await saveDigestDeliveries(
        runId,
        [
          ...digestSendResult.sent
            .map((s) => ({
              subscriber_id: subscriberByEmail.get(s.email),
              status: 'sent' as const,
              sent_at: new Date().toISOString(),
            }))
            .filter((d): d is { subscriber_id: string; status: 'sent'; sent_at: string } =>
              Boolean(d.subscriber_id)),
          ...digestSendResult.failed
            .map((f) => ({
              subscriber_id: subscriberByEmail.get(f.email),
              status: 'failed' as const,
              error_message: f.error,
            }))
            .filter((d): d is { subscriber_id: string; status: 'failed'; error_message: string } =>
              Boolean(d.subscriber_id)),
        ]
      );
    }

    if (digestSendResult.failed.length > 0) {
      const failedList = digestSendResult.failed
        .map((f) => f.email.replace(/(.{2}).*(@.*)/, '$1***$2'))
        .join(', ');
      try {
        await sendAlertEmail(`日报部分发送失败（${digestSendResult.failed.length}个）: ${failedList}`);
      } catch (alertErr) {
        console.error('[Main] Failed to send partial-failure alert email:', alertErr);
      }
    }

    // ------------------------------------------------------------------
    // Step 5: Store in Supabase (after email succeeds)
    // ------------------------------------------------------------------
    console.log('[Main] Step 5/5: Saving to Supabase...');

    const insertedCount = await upsertArticles(finalArticles);
    console.log(`[Main] ${insertedCount} articles saved to database`);

    // Save digest record (marks this date as "done" for idempotency)
    await saveDigest({
      date,
      sent_at: new Date().toISOString(),
      article_count: finalArticles.length,
      email_html: emailHtml,
      run_id: runId,
      status: 'sent',
    });

    await markRunSent(runId, finalArticles.length);

    // ------------------------------------------------------------------
    // Done
    // ------------------------------------------------------------------
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Done in ${elapsed(startTime)}s`);
    const email = process.env.DIGEST_EMAIL ?? '';
    const masked = email.replace(/(.{2}).*(@.*)/, '$1***$2');
    console.log(`  ${finalArticles.length} articles → digest completed (default recipient: ${masked})`);
    console.log(`${'='.repeat(60)}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (emailSent) {
        await markRunSent(runId, sentArticleCount, `Post-send warning: ${message}`);
      } else {
        await markRunFailed(runId, message);
      }
    } catch (runErr) {
      console.error('[Main] Failed to update run status:', runErr);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const PIPELINE_TIMEOUT_MS = 10 * 60 * 1_000;
export async function runPipelineWithTimeout(
  timeoutMs = PIPELINE_TIMEOUT_MS,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Pipeline timeout (10 min)')),
      timeoutMs,
    );
  });

  try {
    await Promise.race([runPipeline(), timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

if (process.env.AMZ_SKIP_MAIN_AUTORUN !== '1') {
  runPipelineWithTimeout().catch((err) => {
    console.error('[Main] Fatal error:', err);
    process.exit(1);
  });
}
