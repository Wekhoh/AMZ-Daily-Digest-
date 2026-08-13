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
  getRecentDigests,
  getActiveSubscribers,
  saveDigestDeliveries,
} from './store.js';
import { generateEmailHtml, sendDigestEmail, sendAlertEmail } from './email.js';
import { writeDigestJson } from './publish.js';
import type { Article } from './store.js';
import { canonicalizeUrl } from './utils.js';
import { AI, SOURCE_HEALTH } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RECENT_DIGEST_EXCLUDE_DAYS_DEFAULT = 2;
const DIGEST_LINK_REGEX = /<a\s+href="([^"]+)"/gi;
const DIGEST_SOURCE_REGEX = /来源:\s*([^<\n\r]+)/gi;
const REDDIT_RECOVERY_ATTEMPTS_DEFAULT = 2;
const REDDIT_RECOVERY_DELAY_MS_DEFAULT = 3_000;
const COLLECTOR_RECOVERY_ATTEMPTS_DEFAULT = 1;
const COLLECTOR_RECOVERY_DELAY_MS_DEFAULT = 2_000;
const SECONDARY_COVERAGE_ALERT_STREAK_DEFAULT = 2;
// UTC weekday (0=Sunday) on which a persisting secondary coverage gap re-alerts.
const SECONDARY_COVERAGE_REALERT_UTC_WEEKDAY = 1;

export interface SourceGroupTarget {
  key: 'wearesellers' | 'amz123' | 'reddit' | 'sellercentral';
  label: string;
  sources: string[];
  min: number;
}

export interface MissingSourceGroup {
  target: SourceGroupTarget;
  count: number;
  missing: number;
}

const SOURCE_GROUP_DEFINITIONS: ReadonlyArray<{
  key: SourceGroupTarget['key'];
  label: string;
  sources: string[];
}> = [
  { key: 'wearesellers', label: '知无不言', sources: ['wearesellers'] },
  { key: 'amz123', label: 'AMZ123', sources: ['amz123'] },
  { key: 'reddit', label: 'Reddit', sources: ['reddit_fba', 'reddit_seller'] },
  { key: 'sellercentral', label: 'SellerCentral', sources: ['sellercentral'] },
] as const;

interface SourceGroupCounts {
  wearesellers: number;
  amz123: number;
  reddit: number;
  sellercentral: number;
}

const SECONDARY_SOURCE_GROUP_KEYS = new Set<SourceGroupTarget['key']>(['sellercentral']);

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function elapsed(start: number): string {
  return ((Date.now() - start) / 1_000).toFixed(1);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function resolvePositiveIntFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function injectDigestWarnings(html: string, warnings: string[]): string {
  if (warnings.length === 0) {
    return html;
  }

  const warningItems = warnings
    .map(
      (warning) =>
        `<li style="margin:0 0 6px 0;line-height:1.6;">${escapeHtmlText(warning)}</li>`,
    )
    .join('');

  const warningBlock = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;">
      <tr>
        <td style="background:#fff5f5;border:1px solid #feb2b2;border-radius:8px;padding:12px 14px;">
          <p style="margin:0 0 6px 0;font-size:13px;color:#9b2c2c;font-weight:700;">⚠ 系统提醒</p>
          <ul style="margin:0;padding-left:18px;font-size:12px;color:#7f1d1d;">
            ${warningItems}
          </ul>
        </td>
      </tr>
    </table>`;

  const bodyMarker = '<td style="padding:32px 28px 16px 28px;">';
  if (html.includes(bodyMarker)) {
    return html.replace(bodyMarker, `${bodyMarker}${warningBlock}`);
  }
  return `${warningBlock}${html}`;
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

function getArticleKey(article: Article): string {
  return article.canonical_url ?? article.url;
}

function countArticlesForSources(articles: Article[], sources: string[]): number {
  if (sources.length === 0) {
    return 0;
  }
  const sourceSet = new Set(sources);
  return articles.filter((item) => sourceSet.has(item.source)).length;
}

function evaluateSourceGroupCoverage(
  articles: Article[],
  targets: SourceGroupTarget[],
): { missingTags: string[]; missingSlots: number; missingGroups: MissingSourceGroup[] } {
  if (targets.length === 0) {
    return { missingTags: [], missingSlots: 0, missingGroups: [] };
  }

  const missingTags: string[] = [];
  const missingGroups: MissingSourceGroup[] = [];
  let missingSlots = 0;

  for (const target of targets) {
    const count = countArticlesForSources(articles, target.sources);
    if (count >= target.min) {
      continue;
    }
    const missing = target.min - count;
    missingTags.push(`${target.label}=${count}/${target.min}`);
    missingSlots += missing;
    missingGroups.push({ target, count, missing });
  }

  return { missingTags, missingSlots, missingGroups };
}

function applySourceGroupTargets(
  rankedArticles: Article[],
  targets: SourceGroupTarget[],
  limit: number,
): { articles: Article[]; missingTags: string[]; missingGroups: MissingSourceGroup[] } {
  const ranked = dedupeByUrl(rankedArticles);
  if (targets.length === 0) {
    return { articles: ranked.slice(0, limit), missingTags: [], missingGroups: [] };
  }

  const required: Article[] = [];
  const requiredKeys = new Set<string>();

  for (const target of targets) {
    let added = 0;
    for (const article of ranked) {
      if (added >= target.min) {
        break;
      }
      if (!target.sources.includes(article.source)) {
        continue;
      }
      const key = getArticleKey(article);
      if (requiredKeys.has(key)) {
        continue;
      }
      required.push(article);
      requiredKeys.add(key);
      added += 1;
    }
  }

  const rankIndex = new Map(ranked.map((item, index) => [getArticleKey(item), index]));
  const requiredSorted = [...required].sort(
    (a, b) => (rankIndex.get(getArticleKey(a)) ?? Number.MAX_SAFE_INTEGER) -
      (rankIndex.get(getArticleKey(b)) ?? Number.MAX_SAFE_INTEGER),
  );

  const selected: Article[] = [];
  const selectedKeys = new Set<string>();
  for (const article of requiredSorted) {
    if (selected.length >= limit) break;
    const key = getArticleKey(article);
    if (selectedKeys.has(key)) continue;
    selected.push(article);
    selectedKeys.add(key);
  }

  for (const article of ranked) {
    if (selected.length >= limit) {
      break;
    }
    const key = getArticleKey(article);
    if (selectedKeys.has(key)) {
      continue;
    }
    selected.push(article);
    selectedKeys.add(key);
  }

  const coverage = evaluateSourceGroupCoverage(selected, targets);
  return {
    articles: selected,
    missingTags: coverage.missingTags,
    missingGroups: coverage.missingGroups,
  };
}

function buildActiveSourceGroupTargets(counts: SourceGroupCounts): SourceGroupTarget[] {
  const allTargets: SourceGroupTarget[] = SOURCE_GROUP_DEFINITIONS.map((group) => ({
    key: group.key,
    label: group.label,
    sources: [...group.sources],
    min: 1,
  }));

  return allTargets.filter((target) => {
    if (target.key === 'reddit') {
      return counts.reddit > 0;
    }
    return counts[target.key] > 0;
  });
}

function parsePublishedAt(article: Article): Date | null {
  if (!article.published_at) {
    return null;
  }
  const parsed = new Date(article.published_at);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function isPublishedOnDigestDate(article: Article, date: string): boolean {
  const parsed = parsePublishedAt(article);
  if (!parsed) {
    return false;
  }
  return parsed.toISOString().slice(0, 10) === date;
}

function compareNewestFirst(a: Article, b: Article): number {
  const aTime = parsePublishedAt(a)?.getTime() ?? 0;
  const bTime = parsePublishedAt(b)?.getTime() ?? 0;
  if (aTime !== bTime) {
    return bTime - aTime;
  }
  return (b.score ?? 0) - (a.score ?? 0);
}

function prioritizeFreshArticles(
  articles: Article[],
  date: string,
  limit: number = AI.MAX_ARTICLES,
): Article[] {
  const deduped = dedupeByUrl(articles).slice(0, limit * 2);
  const fresh = deduped
    .filter((item) => isPublishedOnDigestDate(item, date))
    .sort(compareNewestFirst);
  const stale = deduped
    .filter((item) => !isPublishedOnDigestDate(item, date))
    .sort(compareNewestFirst);

  const desiredFresh = Math.min(AI.FRESH_TARGET_MIN, fresh.length, limit);
  const selected: Article[] = [];
  const seen = new Set<string>();

  for (const article of fresh.slice(0, desiredFresh)) {
    const key = article.canonical_url ?? article.url;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(article);
  }

  for (const article of [...fresh.slice(desiredFresh), ...stale]) {
    if (selected.length >= limit) break;
    const key = article.canonical_url ?? article.url;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(article);
  }

  return selected;
}

function prioritizePreferredSources(
  articles: Article[],
  preferredSources: string[],
  preferredMin: number,
): Article[] {
  if (preferredSources.length === 0 || preferredMin <= 0) {
    return dedupeByUrl(articles).slice(0, AI.MAX_ARTICLES);
  }

  const preferredSet = new Set(preferredSources);
  const prioritized = dedupeByUrl(articles);
  const preferred = prioritized.filter((item) => preferredSet.has(item.source));
  const others = prioritized.filter((item) => !preferredSet.has(item.source));
  const front = preferred.slice(0, preferredMin);
  const frontKeys = new Set(front.map((item) => item.canonical_url ?? item.url));
  const tail = [...preferred.slice(preferredMin), ...others].filter(
    (item) => !frontKeys.has(item.canonical_url ?? item.url),
  );

  return [...front, ...tail].slice(0, AI.MAX_ARTICLES);
}

function resolveRecentDigestExclusionDays(
  override = process.env.AMZ_RECENT_DIGEST_EXCLUDE_DAYS,
): number {
  if (!override) {
    return RECENT_DIGEST_EXCLUDE_DAYS_DEFAULT;
  }

  const parsed = Number.parseInt(override, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[Main] Invalid AMZ_RECENT_DIGEST_EXCLUDE_DAYS=${override}; ` +
      `fallback to ${RECENT_DIGEST_EXCLUDE_DAYS_DEFAULT}`,
    );
    return RECENT_DIGEST_EXCLUDE_DAYS_DEFAULT;
  }

  return parsed;
}

function extractUrlsFromDigestHtml(html: string): string[] {
  const urls = new Set<string>();
  let match: RegExpExecArray | null = DIGEST_LINK_REGEX.exec(html);
  while (match) {
    const rawUrl = match[1];
    const canonical = canonicalizeUrl(rawUrl) ?? rawUrl;
    urls.add(canonical);
    match = DIGEST_LINK_REGEX.exec(html);
  }
  DIGEST_LINK_REGEX.lastIndex = 0;
  return [...urls];
}

async function getRecentDigestExclusionUrls(currentDate: string): Promise<string[]> {
  const cooldownDays = resolveRecentDigestExclusionDays();
  if (cooldownDays <= 0) {
    return [];
  }

  const current = new Date(`${currentDate}T00:00:00.000Z`);
  if (Number.isNaN(current.getTime())) {
    return [];
  }

  const cutoff = new Date(current);
  cutoff.setUTCDate(cutoff.getUTCDate() - cooldownDays);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const history = await getRecentDigests(Math.max(14, cooldownDays + 7));
  const urls = new Set<string>();

  for (const digest of history) {
    if (digest.date >= currentDate || digest.date < cutoffDate) {
      continue;
    }
    if (!digest.email_html) {
      continue;
    }

    for (const url of extractUrlsFromDigestHtml(digest.email_html)) {
      urls.add(url);
    }
  }

  return [...urls];
}

interface DigestWindowOptions {
  preferredSources?: string[];
  preferredMin?: number;
  fallbackMultiplier?: number;
  sourceGroupTargets?: SourceGroupTarget[];
}

async function ensureDigestWindow(
  date: string,
  selected: Article[],
  recentDigestExcludeUrls: string[],
  options: DigestWindowOptions = {},
): Promise<Article[]> {
  const preferredSources = options.preferredSources ?? [];
  const preferredMin = options.preferredMin ?? 0;
  const fallbackMultiplier = Math.max(1, options.fallbackMultiplier ?? 4);
  const sourceGroupTargets = options.sourceGroupTargets ?? [];
  const candidateLimit = preferredSources.length > 0
    ? AI.MAX_ARTICLES * 2
    : AI.MAX_ARTICLES;
  const dedupedSelected = dedupeByUrl(selected);
  const strictInitial = dedupedSelected.filter((item) => (item.score ?? 0) >= AI.MIN_SCORE);
  const relaxedInitial = dedupedSelected.filter(
    (item) => (item.score ?? 0) >= AI.RELAXED_MIN_SCORE && (item.score ?? 0) < AI.MIN_SCORE,
  );

  const strictInitialPrioritized = prioritizeFreshArticles(
    strictInitial,
    date,
    candidateLimit,
  )
    .slice(0, candidateLimit);
  const strictInitialPreferred = prioritizePreferredSources(
    strictInitialPrioritized,
    preferredSources,
    preferredMin,
  ).slice(0, AI.MAX_ARTICLES);
  const strictInitialCoverage = evaluateSourceGroupCoverage(
    strictInitialPreferred,
    sourceGroupTargets,
  );
  if (
    strictInitialPreferred.length >= AI.MIN_ARTICLES &&
    strictInitialCoverage.missingSlots === 0
  ) {
    return strictInitialPreferred.slice(0, AI.MAX_ARTICLES);
  }

  const excludeUrls = new Set<string>([
    ...dedupedSelected.map((item) => getArticleKey(item)),
    ...recentDigestExcludeUrls,
  ]);
  const minCountNeeded = Math.max(0, AI.MIN_ARTICLES - strictInitialPrioritized.length);
  const needed = Math.max(minCountNeeded, strictInitialCoverage.missingSlots);
  const fallbackLimit = Math.min(
    AI.MAX_ARTICLES * 6,
    Math.max(needed * fallbackMultiplier, AI.BATCH_SIZE * 2),
  );
  const strictFallbackPool = await getFallbackArticlesForDigest({
    limit: fallbackLimit,
    minScore: AI.MIN_SCORE,
    excludeUrls: [...excludeUrls],
  });
  const strictFallback = strictFallbackPool.filter((article) => {
    const key = getArticleKey(article);
    return !excludeUrls.has(key);
  });
  for (const article of strictFallback) {
    excludeUrls.add(getArticleKey(article));
  }

  const strictMerged = prioritizeFreshArticles(
    [...strictInitialPrioritized, ...strictFallback],
    date,
    candidateLimit,
  ).slice(0, candidateLimit);

  let relaxedFallbackPoolSize = 0;
  let relaxedFallback: Article[] = [];
  let relaxedUsed: Article[] = [];

  if (strictMerged.length < AI.MIN_ARTICLES) {
    const relaxedFallbackPool = await getFallbackArticlesForDigest({
      limit: fallbackLimit,
      minScore: AI.RELAXED_MIN_SCORE,
      excludeUrls: [...excludeUrls],
    });
    relaxedFallbackPoolSize = relaxedFallbackPool.length;
    relaxedFallback = relaxedFallbackPool.filter((article) => {
      const key = getArticleKey(article);
      return !excludeUrls.has(key);
    });

    const relaxedCandidates = prioritizeFreshArticles(
      [...relaxedInitial, ...relaxedFallback],
      date,
      candidateLimit,
    ).slice(0, candidateLimit);
    const neededRelaxed = Math.max(0, AI.MIN_ARTICLES - strictMerged.length);
    relaxedUsed = relaxedCandidates.slice(0, neededRelaxed);
  }

  const mergedBase = prioritizeFreshArticles(
    [...strictMerged, ...relaxedUsed],
    date,
    candidateLimit,
  ).slice(0, candidateLimit);
  const strictPreferred = prioritizePreferredSources(
    strictMerged,
    preferredSources,
    preferredMin,
  ).slice(0, candidateLimit);
  const strictCoverageResult = applySourceGroupTargets(
    strictPreferred,
    sourceGroupTargets,
    AI.MAX_ARTICLES,
  );
  const strictOnlyMerged = strictCoverageResult.articles;

  const mergedPreferred = prioritizePreferredSources(
    mergedBase,
    preferredSources,
    preferredMin,
  ).slice(0, candidateLimit);
  const mergedCoverageResult = applySourceGroupTargets(
    mergedPreferred,
    sourceGroupTargets,
    AI.MAX_ARTICLES,
  );
  const merged = mergedCoverageResult.articles;
  if (preferredSources.length > 0) {
    const preferredSet = new Set(preferredSources);
    const availablePreferred = mergedBase.filter((item) => preferredSet.has(item.source)).length;
    const selectedPreferred = merged.filter((item) => preferredSet.has(item.source)).length;
    console.log(
      `[Main] Preferred-source boost: preferred=${preferredSources.join(',')} ` +
      `available=${availablePreferred}, selected=${selectedPreferred}, target=${preferredMin}`,
    );
  }

  const filteredOutCount =
    strictFallbackPool.length + relaxedFallbackPoolSize - strictFallback.length - relaxedFallback.length;

  const freshCount = merged.filter((item) => isPublishedOnDigestDate(item, date)).length;
  const strictFreshCount = strictOnlyMerged.filter(
    (item) => isPublishedOnDigestDate(item, date),
  ).length;
  const relaxedNeededForMinimum = Math.max(0, AI.MIN_ARTICLES - strictOnlyMerged.length);
  const shouldUseLowVolumeMode =
    strictOnlyMerged.length < AI.MIN_ARTICLES &&
    strictOnlyMerged.length >= AI.DEGRADED_MIN_ARTICLES &&
    (
      merged.length < AI.MIN_ARTICLES ||
      relaxedNeededForMinimum > AI.MAX_RELAXED_TOPUP_FOR_FULL
    );

  const chosenCoverage = shouldUseLowVolumeMode
    ? strictCoverageResult
    : mergedCoverageResult;
  if (chosenCoverage.missingTags.length > 0) {
    const coverageAlert =
      `[SOURCE_COVERAGE_GAP] ${date} 分源最低配额未满足: ${chosenCoverage.missingTags.join(', ')}`;
    console.warn(`[Main] ${coverageAlert}`);
    const coverageDecision = await decideCoverageGapAlert(
      date,
      chosenCoverage.missingGroups,
    );

    if (coverageDecision.shouldAlert) {
      try {
        const streakDetail = coverageDecision.streakTags.length > 0
          ? `\nSecondary streak: ${coverageDecision.streakTags.join(', ')}`
          : '';
        await sendAlertEmail(
          `${coverageAlert}${streakDetail}\n` +
          'Pipeline 已继续执行（不中断）。请检查来源当日可用内容与来源健康状态。',
        );
      } catch (alertErr) {
        console.error('[Main] Failed to send source-coverage alert email:', alertErr);
      }
    } else {
      console.log(
        `[Main] Coverage-gap alert suppressed for secondary sources: ` +
        `${coverageDecision.suppressedTags.join(', ')}`,
      );
    }
  }

  if (shouldUseLowVolumeMode) {
    const reason = merged.length < AI.MIN_ARTICLES
      ? 'insufficient_fallback'
      : 'quality_guard';
    const lowVolumeMessage =
      `[LOW_VOLUME_MODE] ${date} strict=${strictOnlyMerged.length}/${AI.MIN_ARTICLES}, ` +
      `merged=${merged.length}, relaxed_needed=${relaxedNeededForMinimum}, ` +
      `relaxed_used=${relaxedUsed.length}, reason=${reason}`;

    console.warn(`[Main] ${lowVolumeMessage}`);
    try {
      await sendAlertEmail(`${lowVolumeMessage}\n已启用低容量高质量推送模式。`);
    } catch (alertErr) {
      console.error('[Main] Failed to send low-volume alert email:', alertErr);
    }

    if (filteredOutCount > 0 || recentDigestExcludeUrls.length > 0) {
      console.log(
        `[Main] Removed ${filteredOutCount} fallback articles already delivered in recent digests ` +
        `(cooldown pool size=${recentDigestExcludeUrls.length})`,
      );
    }

    if (strictOnlyMerged.length > strictInitialPrioritized.length) {
      console.log(
        `[Main] Topped up digest with ${strictOnlyMerged.length - strictInitialPrioritized.length} fallback articles ` +
        `(strict fallback=${strictFallback.length}, relaxed fallback=0)`,
      );
    }

    console.log(
      `[Main] Freshness priority applied: ${strictFreshCount}/${strictOnlyMerged.length} articles published on ${date}`,
    );
    return strictOnlyMerged;
  }

  if (merged.length < AI.MIN_ARTICLES) {
    const message =
      `[Main] Final digest for ${date} below minimum: ${merged.length}/${AI.MIN_ARTICLES} ` +
      `(strict fallback=${strictFallback.length}, relaxed fallback=${relaxedUsed.length})`;
    await sendAlertEmail(`${message}\n请检查采集源稳定性、去重与筛选阈值。`);
    throw new Error(`${message} — aborting send`);
  }

  if (filteredOutCount > 0 || recentDigestExcludeUrls.length > 0) {
    console.log(
      `[Main] Removed ${filteredOutCount} fallback articles already delivered in recent digests ` +
      `(cooldown pool size=${recentDigestExcludeUrls.length})`,
    );
  }

  if (merged.length > strictInitialPrioritized.length) {
    console.log(
      `[Main] Topped up digest with ${merged.length - strictInitialPrioritized.length} fallback articles ` +
      `(strict fallback=${strictFallback.length}, relaxed fallback=${relaxedUsed.length})`,
    );
  }
  console.log(
    `[Main] Freshness priority applied: ${freshCount}/${merged.length} articles published on ${date}`,
  );

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
    'DEEPSEEK_API_KEY',
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

interface CollectorRecoveryOptions {
  attempts: number;
  delayMs: number;
}

async function collectWithRecovery(
  name: string,
  fn: () => Promise<Article[]>,
  options: CollectorRecoveryOptions,
): Promise<Article[]> {
  const { attempts, delayMs } = options;
  let articles = await safeCollect(name, fn);

  if (articles.length > 0 || attempts <= 0) {
    return articles;
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const waitMs = Math.max(0, delayMs * attempt);
    console.warn(
      `[Main] Collector "${name}" returned 0, retrying ${attempt}/${attempts}` +
      `${waitMs > 0 ? ` after ${waitMs}ms` : ''}...`,
    );

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    articles = await safeCollect(`${name}-retry-${attempt}`, fn);
    if (articles.length > 0) {
      console.log(
        `[Main] Collector "${name}" recovered with ${articles.length} articles on retry ${attempt}`,
      );
      break;
    }
  }

  return articles;
}

function extractSourcesFromDigestHtml(html: string): Set<string> {
  const sources = new Set<string>();
  let match: RegExpExecArray | null = DIGEST_SOURCE_REGEX.exec(html);
  while (match) {
    const source = match[1]?.trim();
    if (source) {
      sources.add(source);
    }
    match = DIGEST_SOURCE_REGEX.exec(html);
  }
  DIGEST_SOURCE_REGEX.lastIndex = 0;
  return sources;
}

function digestContainsAnySource(html: string, sources: string[]): boolean {
  if (!html || sources.length === 0) {
    return false;
  }
  const sourceSet = extractSourcesFromDigestHtml(html);
  return sources.some((source) => sourceSet.has(source));
}

async function getMissingCoverageStreakBeforeDate(
  date: string,
  target: SourceGroupTarget,
): Promise<number> {
  const history = await getRecentDigests(14);
  const sortedHistory = [...history].sort((a, b) => (a.date < b.date ? 1 : -1));
  let streak = 0;

  for (const digest of sortedHistory) {
    if (digest.date >= date) {
      continue;
    }

    if (digestContainsAnySource(digest.email_html ?? '', target.sources)) {
      break;
    }

    streak += 1;
  }

  return streak;
}

function isSecondaryCoverageRealertDay(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.getUTCDay() === SECONDARY_COVERAGE_REALERT_UTC_WEEKDAY;
}

export interface CoverageGapAlertDecision {
  shouldAlert: boolean;
  streakTags: string[];
  suppressedTags: string[];
}

export async function decideCoverageGapAlert(
  date: string,
  missingGroups: MissingSourceGroup[],
): Promise<CoverageGapAlertDecision> {
  if (missingGroups.length === 0) {
    return { shouldAlert: false, streakTags: [], suppressedTags: [] };
  }

  const primaryMissing = missingGroups.filter(
    (group) => !SECONDARY_SOURCE_GROUP_KEYS.has(group.target.key),
  );
  if (primaryMissing.length > 0) {
    return { shouldAlert: true, streakTags: [], suppressedTags: [] };
  }

  const threshold = Math.max(
    1,
    resolvePositiveIntFromEnv(
      process.env.AMZ_SECONDARY_COVERAGE_ALERT_STREAK,
      SECONDARY_COVERAGE_ALERT_STREAK_DEFAULT,
    ),
  );
  const streakTags: string[] = [];
  const suppressedTags: string[] = [];
  let shouldAlert = false;
  const isRealertDay = isSecondaryCoverageRealertDay(date);

  for (const group of missingGroups) {
    const historyStreak = await getMissingCoverageStreakBeforeDate(date, group.target);
    const consecutive = historyStreak + 1;
    streakTags.push(`${group.target.label}=${consecutive}/${threshold}`);
    // Fire on the day the streak first crosses the threshold, then at most weekly
    // (Monday UTC) while the gap persists — repeating an identical alert daily is
    // noise, not signal (2026-08 SellerCentral incident: 10 straight daily emails).
    if (consecutive === threshold || (consecutive > threshold && isRealertDay)) {
      shouldAlert = true;
    } else {
      suppressedTags.push(`${group.target.label}=${consecutive}/${threshold}`);
    }
  }

  return { shouldAlert, streakTags, suppressedTags };
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

    const collectorRecoveryDelayMs = resolvePositiveIntFromEnv(
      process.env.AMZ_COLLECTOR_RECOVERY_DELAY_MS,
      COLLECTOR_RECOVERY_DELAY_MS_DEFAULT,
    );
    const wearesellersRecoveryAttempts = resolvePositiveIntFromEnv(
      process.env.AMZ_WS_RECOVERY_ATTEMPTS,
      COLLECTOR_RECOVERY_ATTEMPTS_DEFAULT,
    );
    const rssRecoveryAttempts = resolvePositiveIntFromEnv(
      process.env.AMZ_RSS_RECOVERY_ATTEMPTS,
      COLLECTOR_RECOVERY_ATTEMPTS_DEFAULT,
    );
    const sellercentralRecoveryAttempts = resolvePositiveIntFromEnv(
      process.env.AMZ_SC_RECOVERY_ATTEMPTS,
      COLLECTOR_RECOVERY_ATTEMPTS_DEFAULT,
    );

    const [
      wearesellersArticles,
      rssArticles,
      initialRedditArticles,
      sellerCentralArticles,
    ] = await Promise.all([
      collectWithRecovery('wearesellers', collectWeAreSellers, {
        attempts: wearesellersRecoveryAttempts,
        delayMs: collectorRecoveryDelayMs,
      }),
      collectWithRecovery('rss', collectRSS, {
        attempts: rssRecoveryAttempts,
        delayMs: collectorRecoveryDelayMs,
      }),
      safeCollect('reddit', collectReddit),
      collectWithRecovery('sellercentral', collectSellerCentral, {
        attempts: sellercentralRecoveryAttempts,
        delayMs: collectorRecoveryDelayMs,
      }),
    ]);
    let redditArticles = initialRedditArticles;

    const redditRecoveryAttempts = resolvePositiveIntFromEnv(
      process.env.AMZ_REDDIT_RECOVERY_ATTEMPTS,
      REDDIT_RECOVERY_ATTEMPTS_DEFAULT,
    );
    const redditRecoveryDelayMs = resolvePositiveIntFromEnv(
      process.env.AMZ_REDDIT_RECOVERY_DELAY_MS,
      REDDIT_RECOVERY_DELAY_MS_DEFAULT,
    );
    let redditRecovered = false;
    let redditRecoveryTried = 0;

    if (redditArticles.length === 0 && redditRecoveryAttempts > 0) {
      for (let attempt = 1; attempt <= redditRecoveryAttempts; attempt++) {
        redditRecoveryTried = attempt;
        console.warn(
          `[Main] Reddit initial collect returned 0. ` +
          `Starting recovery attempt ${attempt}/${redditRecoveryAttempts} (collector has multi-route fallback).`,
        );
        const recovered = await safeCollect(`reddit-recovery-${attempt}`, collectReddit);
        if (recovered.length > 0) {
          redditArticles = recovered;
          redditRecovered = true;
          console.log(
            `[Main] Reddit recovery succeeded on attempt ${attempt}: ${recovered.length} articles`,
          );
          break;
        }
        if (attempt < redditRecoveryAttempts && redditRecoveryDelayMs > 0) {
          await sleep(redditRecoveryDelayMs * attempt);
        }
      }
    }

    // Alert if WeAreSellers (P0 source) returned too few — likely cookie expired or scraping degraded
    if (wearesellersArticles.length < SOURCE_HEALTH.WEARESELLERS_MIN_ARTICLES) {
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

    const primarySourceGapTags: string[] = [];
    if (redditArticles.length < SOURCE_HEALTH.REDDIT_MIN_ARTICLES) {
      primarySourceGapTags.push(
        `Reddit=${redditArticles.length}/${SOURCE_HEALTH.REDDIT_MIN_ARTICLES}`,
      );
    }
    if (sellerCentralArticles.length < SOURCE_HEALTH.SELLERCENTRAL_MIN_ARTICLES) {
      console.warn(
        `[Main] [SOURCE_GAP_SECONDARY] ${date} SellerCentral=${sellerCentralArticles.length}/` +
        `${SOURCE_HEALTH.SELLERCENTRAL_MIN_ARTICLES}; skip immediate alert and rely on streak-based coverage alert.`,
      );
    }
    if (primarySourceGapTags.length > 0) {
      const sourceGapAlert =
        `[SOURCE_GAP] ${date} 关键来源低于阈值: ${primarySourceGapTags.join(', ')}`;
      console.warn(`[Main] ${sourceGapAlert}`);
      try {
        await sendAlertEmail(
          `${sourceGapAlert}\n` +
          'Pipeline 已继续执行（不中断）。请检查对应采集器可用性与来源侧可访问性。',
        );
      } catch (alertErr) {
        console.error('[Main] Failed to send source-gap alert email:', alertErr);
      }
    }

    const digestWarnings: string[] = [];
    if (redditArticles.length === 0) {
      const redditRecoveryFailureAlert =
        `[REDDIT_RECOVERY_FAILED] ${date} Reddit after initial+${redditRecoveryTried} recovery attempt(s) ` +
        'still returned 0. Pipeline will continue with explicit warning in digest.';
      console.warn(`[Main] ${redditRecoveryFailureAlert}`);
      digestWarnings.push('今日 Reddit 采集失败（已自动重试恢复但未成功）');
      try {
        await sendAlertEmail(
          `${redditRecoveryFailureAlert}\n` +
          '请检查来源侧封禁、网络可达性与采集器兼容性。',
        );
      } catch (alertErr) {
        console.error('[Main] Failed to send reddit-recovery-failed alert email:', alertErr);
      }
    } else if (redditRecovered) {
      digestWarnings.push('Reddit 采集已自动恢复成功（本次推送已纳入恢复结果）');
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
        `Reddit: ${redditArticles.length}, SellerCentral: ${sellerCentralArticles.length}, ` +
        `RedditRecovery: ${redditRecovered ? `recovered@${redditRecoveryTried}` : `none@${redditRecoveryTried}`})`
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

    const recentDigestExcludeUrls = await getRecentDigestExclusionUrls(date);
    const strictQualityCount = processed.filter(
      (item) => (item.score ?? 0) >= AI.MIN_SCORE,
    ).length;
    const sourceGroupTargets = buildActiveSourceGroupTargets({
      wearesellers: wearesellersArticles.length,
      amz123: rssArticles.length,
      reddit: redditArticles.length,
      sellercentral: sellerCentralArticles.length,
    });
    const shouldBoostReddit =
      wearesellersArticles.length < SOURCE_HEALTH.WEARESELLERS_MIN_ARTICLES &&
      strictQualityCount < AI.MIN_ARTICLES;
    if (shouldBoostReddit) {
      console.warn(
        `[Main] Reddit boost enabled: wearesellers=${wearesellersArticles.length}/${SOURCE_HEALTH.WEARESELLERS_MIN_ARTICLES}, ` +
        `strict_quality=${strictQualityCount}/${AI.MIN_ARTICLES}`,
      );
    }
    const finalArticles = await ensureDigestWindow(
      date,
      processed,
      recentDigestExcludeUrls,
      shouldBoostReddit
        ? {
            preferredSources: ['reddit_fba', 'reddit_seller'],
            preferredMin: SOURCE_HEALTH.REDDIT_BOOST_TARGET,
            fallbackMultiplier: SOURCE_HEALTH.REDDIT_BOOST_FALLBACK_MULTIPLIER,
            sourceGroupTargets,
          }
        : { sourceGroupTargets },
    );
    sentArticleCount = finalArticles.length;

    // ------------------------------------------------------------------
    // Step 4: Generate and send digest email (BEFORE storing to DB)
    // If email fails, this run is marked failed. If post-send persistence fails,
    // run remains "sent" to prevent duplicate delivery on retry.
    // ------------------------------------------------------------------
    console.log('[Main] Step 4/5: Generating and sending email...');

    const baseEmailHtml = generateEmailHtml(finalArticles, date);
    const emailHtml = injectDigestWarnings(baseEmailHtml, digestWarnings);
    // email leg retired per Director ruling 2026-07-29; delete the env line in the
    // workflow to restore. Only the daily briefing delivery is disabled: HTML
    // generation above stays (persisted and read back by dedup + coverage checks),
    // and every sendAlertEmail path stays armed.
    if (process.env.AMZ_DIGEST_EMAIL_ENABLED !== '0') {
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
    } else {
      console.log('[Main] Step 4/5: email delivery disabled (AMZ_DIGEST_EMAIL_ENABLED=0); HTML generated, send skipped');
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
    // Step 6: Publish the machine-readable digest (amz-autopilot reads this over
    // a credential-free HTTPS GET; the workflow commits it). Non-fatal — a write
    // failure must never fail an already-sent digest (post-send policy).
    // ------------------------------------------------------------------
    try {
      const published = await writeDigestJson(finalArticles, date);
      console.log(
        `[Main] Published ${published.articles.length}/${published.article_count} articles to public/digest-latest.json`,
      );
    } catch (publishErr) {
      console.error('[Main] Failed to write public/digest-latest.json (non-fatal):', publishErr);
    }

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
