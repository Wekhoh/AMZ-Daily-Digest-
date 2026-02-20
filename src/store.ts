import { createClient, SupabaseClient } from '@supabase/supabase-js';
import 'dotenv/config';

export interface Article {
  source: string;
  url: string;
  raw_url?: string;
  canonical_url?: string;
  title: string;
  content?: string;
  summary?: string;
  category?: string;
  score?: number;
  keywords?: string[];
  published_at?: string;
}

export interface Digest {
  date: string;
  sent_at?: string;
  article_count: number;
  email_html: string;
  run_id?: string;
  status?: 'sent' | 'failed' | 'skipped';
}

export interface Subscriber {
  id: string;
  email: string;
  active: boolean;
}

export interface DeliveryResult {
  subscriber_id: string;
  status: 'sent' | 'failed';
  sent_at?: string;
  error_message?: string;
}

export interface DigestRunRecord {
  run_id: string;
  digest_date: string;
  status: 'running' | 'sent' | 'failed' | 'skipped';
  started_at: string;
  finished_at?: string | null;
  article_count: number;
  error_message?: string | null;
}

export interface FallbackQuery {
  limit: number;
  minScore: number;
  excludeUrls: string[];
}

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_KEY env vars');
  }
  client = createClient(url, key);
  return client;
}

/**
 * Check which URLs already exist in DB, returns the set of existing ones.
 * Batches queries to stay within Supabase `.in()` limit (~300 items per call).
 */
const URL_BATCH_SIZE = 200;
const UNDEFINED_COLUMN_CODE = '42703';
const POSTGREST_MISSING_COLUMN_CODE = 'PGRST204';
const UNIQUE_VIOLATION_CODE = '23505';
const POSTGREST_MISSING_TABLE_CODE = 'PGRST205';

export async function getExistingUrls(urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set();

  const db = getClient();
  const existing = new Set<string>();

  for (let i = 0; i < urls.length; i += URL_BATCH_SIZE) {
    const batch = urls.slice(i, i + URL_BATCH_SIZE);
    const canonicalLookup = await db
      .from('articles')
      .select('canonical_url')
      .in('canonical_url', batch);

    if (canonicalLookup.error && isMissingColumnError(canonicalLookup.error.code)) {
      // Backward-compatibility when migration hasn't been applied yet.
      const legacyLookup = await db
        .from('articles')
        .select('url')
        .in('url', batch);

      if (legacyLookup.error) {
        throw new Error(`Failed to check existing URLs: ${legacyLookup.error.message}`);
      }

      for (const row of legacyLookup.data ?? []) {
        existing.add((row as { url: string }).url);
      }
      continue;
    }

    if (canonicalLookup.error) {
      throw new Error(`Failed to check existing URLs: ${canonicalLookup.error.message}`);
    }

    for (const row of canonicalLookup.data ?? []) {
      existing.add((row as { canonical_url: string }).canonical_url);
    }
  }

  return existing;
}

/** Upsert articles, skipping duplicates by URL. Returns count inserted. */
export async function upsertArticles(articles: Article[]): Promise<number> {
  if (articles.length === 0) return 0;

  const db = getClient();
  const normalized = articles.map((article) => ({
    ...article,
    raw_url: article.raw_url ?? article.url,
    canonical_url: article.canonical_url ?? article.url,
  }));

  const modernUpsert = await db
    .from('articles')
    .upsert(
      normalized,
      { onConflict: 'canonical_url', ignoreDuplicates: true }
    )
    .select('id');

  if (modernUpsert.error && isMissingColumnError(modernUpsert.error.code)) {
    // Backward-compatibility when migration hasn't been applied yet.
    const legacyRows = normalized.map(
      ({ raw_url: _rawUrl, canonical_url: _canonicalUrl, ...rest }) => rest
    );
    const legacyUpsert = await db
      .from('articles')
      .upsert(
        legacyRows,
        { onConflict: 'url', ignoreDuplicates: true }
      )
      .select('id');

    if (legacyUpsert.error) {
      throw new Error(`Failed to upsert articles: ${legacyUpsert.error.message}`);
    }
    return legacyUpsert.data?.length ?? 0;
  }

  if (modernUpsert.error) {
    throw new Error(`Failed to upsert articles: ${modernUpsert.error.message}`);
  }
  return modernUpsert.data?.length ?? 0;
}

/** Check if a digest already exists for the given date (idempotency guard) */
export async function getDigestByDate(date: string): Promise<Digest | null> {
  const db = getClient();
  const { data, error } = await db
    .from('digests')
    .select('date, sent_at, article_count, email_html')
    .eq('date', date)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to check digest for ${date}: ${error.message}`);
  }
  return data as Digest | null;
}

/** Save or update a daily digest record */
export async function saveDigest(digest: Digest): Promise<void> {
  const db = getClient();
  const modernUpsert = await db
    .from('digests')
    .upsert(
      {
        date: digest.date,
        sent_at: digest.sent_at,
        article_count: digest.article_count,
        email_html: digest.email_html,
        run_id: digest.run_id,
        status: digest.status ?? 'sent',
      },
      { onConflict: 'date' }
    );

  if (modernUpsert.error && isMissingColumnError(modernUpsert.error.code)) {
    const legacyUpsert = await db
      .from('digests')
      .upsert(
        {
          date: digest.date,
          sent_at: digest.sent_at,
          article_count: digest.article_count,
          email_html: digest.email_html,
        },
        { onConflict: 'date' }
      );
    if (legacyUpsert.error) {
      throw new Error(`Failed to save digest: ${legacyUpsert.error.message}`);
    }
    return;
  }

  if (modernUpsert.error) {
    throw new Error(`Failed to save digest: ${modernUpsert.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Run lock & status tracking
// ---------------------------------------------------------------------------

const RUN_ERROR_LIMIT = 1_000;
const RUN_LOCK_STALE_MS = 90 * 60 * 1_000;

function truncateRunError(message: string): string {
  return message.slice(0, RUN_ERROR_LIMIT);
}

/**
 * Acquire a per-day run lock.
 * Returns false when another run is already active/sent for the same date.
 */
export async function acquireRunLock(date: string, runId: string): Promise<boolean> {
  const db = getClient();
  const insertLock = async () =>
    db.from('digest_runs').insert({
      run_id: runId,
      digest_date: date,
      status: 'running',
    });

  const firstTry = await insertLock();
  if (!firstTry.error) return true;
  if (isMissingTableError(firstTry.error.code)) {
    // Backward compatibility: proceed without run lock when migration wasn't applied yet.
    return true;
  }
  if (firstTry.error.code !== UNIQUE_VIOLATION_CODE) {
    throw new Error(
      `Failed to acquire run lock for ${date}: ${firstTry.error.message} (${firstTry.error.code ?? 'NO_CODE'})`
    );
  }

  const activeRunResult = await db
    .from('digest_runs')
    .select('run_id, status, started_at')
    .eq('digest_date', date)
    .in('status', ['running', 'sent'])
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeRunResult.error) {
    throw new Error(`Failed to inspect run lock for ${date}: ${activeRunResult.error.message}`);
  }

  const activeRun = activeRunResult.data as
    | { run_id: string; status: 'running' | 'sent'; started_at: string }
    | null;

  if (!activeRun) {
    // Race condition: lock row disappeared after unique violation; retry once.
    const retry = await insertLock();
    if (!retry.error) return true;
    if (retry.error.code === UNIQUE_VIOLATION_CODE) return false;
    throw new Error(
      `Failed to re-acquire run lock for ${date}: ${retry.error.message} (${retry.error.code ?? 'NO_CODE'})`
    );
  }

  if (activeRun.status === 'sent') {
    return false;
  }

  const startedAt = new Date(activeRun.started_at).getTime();
  const staleThreshold = Date.now() - RUN_LOCK_STALE_MS;
  const isStale = Number.isFinite(startedAt) && startedAt <= staleThreshold;

  if (!isStale) {
    return false;
  }

  const staleMessage = `Auto-marked stale lock after ${Math.round(RUN_LOCK_STALE_MS / 60_000)} minutes`;
  const releaseResult = await db
    .from('digest_runs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_message: truncateRunError(staleMessage),
    })
    .eq('run_id', activeRun.run_id)
    .eq('status', 'running');

  if (releaseResult.error) {
    throw new Error(`Failed to release stale run lock for ${date}: ${releaseResult.error.message}`);
  }

  const secondTry = await insertLock();
  if (!secondTry.error) return true;
  if (secondTry.error.code === UNIQUE_VIOLATION_CODE) return false;
  throw new Error(
    `Failed to acquire run lock after stale cleanup for ${date}: ${secondTry.error.message} (${secondTry.error.code ?? 'NO_CODE'})`
  );
}

export async function markRunSent(
  runId: string,
  articleCount: number,
  warningMessage?: string
): Promise<void> {
  const db = getClient();
  const { error } = await db
    .from('digest_runs')
    .update({
      status: 'sent',
      finished_at: new Date().toISOString(),
      article_count: articleCount,
      error_message: warningMessage ? truncateRunError(warningMessage) : null,
    })
    .eq('run_id', runId);

  if (error && isMissingTableError(error.code)) {
    return;
  }

  if (error) {
    throw new Error(`Failed to mark run as sent (${runId}): ${error.message}`);
  }
}

export async function markRunFailed(runId: string, errorMessage: string): Promise<void> {
  const db = getClient();
  const { error } = await db
    .from('digest_runs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      error_message: truncateRunError(errorMessage),
    })
    .eq('run_id', runId);

  if (error && isMissingTableError(error.code)) {
    return;
  }

  if (error) {
    throw new Error(`Failed to mark run as failed (${runId}): ${error.message}`);
  }
}

export async function markRunSkipped(runId: string, reason: string): Promise<void> {
  const db = getClient();
  const { error } = await db
    .from('digest_runs')
    .update({
      status: 'skipped',
      finished_at: new Date().toISOString(),
      error_message: truncateRunError(reason),
    })
    .eq('run_id', runId);

  if (error && isMissingTableError(error.code)) {
    return;
  }

  if (error) {
    throw new Error(`Failed to mark run as skipped (${runId}): ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Subscribers & deliveries
// ---------------------------------------------------------------------------

function isMissingColumnError(code: string | undefined): boolean {
  return code === UNDEFINED_COLUMN_CODE || code === POSTGREST_MISSING_COLUMN_CODE;
}

function isMissingTableError(code: string | undefined): boolean {
  // PostgreSQL undefined_table
  return code === '42P01' || code === POSTGREST_MISSING_TABLE_CODE;
}

export async function getActiveSubscribers(): Promise<Subscriber[]> {
  const db = getClient();
  const { data, error } = await db
    .from('subscribers')
    .select('id, email, active')
    .eq('active', true);

  if (error) {
    if (isMissingTableError(error.code)) {
      return [];
    }
    throw new Error(`Failed to fetch active subscribers: ${error.message}`);
  }

  return (data ?? []) as Subscriber[];
}

export async function getSubscribers(limit = 100): Promise<Subscriber[]> {
  const db = getClient();
  const { data, error } = await db
    .from('subscribers')
    .select('id, email, active')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingTableError(error.code)) {
      return [];
    }
    throw new Error(`Failed to fetch subscribers: ${error.message}`);
  }

  return (data ?? []) as Subscriber[];
}

export async function addSubscriber(email: string): Promise<Subscriber> {
  const db = getClient();
  const normalized = email.trim().toLowerCase();

  const { data, error } = await db
    .from('subscribers')
    .upsert(
      { email: normalized, active: true },
      { onConflict: 'email' }
    )
    .select('id, email, active')
    .single();

  if (error) {
    throw new Error(`Failed to add subscriber: ${error.message}`);
  }

  return data as Subscriber;
}

export async function saveDigestDeliveries(
  runId: string,
  deliveries: DeliveryResult[],
): Promise<void> {
  if (deliveries.length === 0) return;

  const db = getClient();
  const rows = deliveries.map((d) => ({
    run_id: runId,
    subscriber_id: d.subscriber_id,
    status: d.status,
    sent_at: d.sent_at,
    error_message: d.error_message ? truncateRunError(d.error_message) : null,
  }));

  const { error } = await db
    .from('digest_deliveries')
    .upsert(rows, { onConflict: 'run_id,subscriber_id' });

  if (error) {
    if (isMissingTableError(error.code)) {
      return;
    }
    throw new Error(`Failed to save digest deliveries: ${error.message}`);
  }
}

export async function getRecentRuns(limit = 14): Promise<DigestRunRecord[]> {
  const db = getClient();
  const { data, error } = await db
    .from('digest_runs')
    .select('run_id, digest_date, status, started_at, finished_at, article_count, error_message')
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingTableError(error.code)) {
      return [];
    }
    throw new Error(`Failed to fetch recent runs: ${error.message}`);
  }

  return (data ?? []) as DigestRunRecord[];
}

export async function getRecentDigests(limit = 30): Promise<Digest[]> {
  const db = getClient();
  const modernResult = await db
    .from('digests')
    .select('date, sent_at, article_count, email_html, run_id, status')
    .order('date', { ascending: false })
    .limit(limit);

  if (modernResult.error && isMissingColumnError(modernResult.error.code)) {
    const legacyResult = await db
      .from('digests')
      .select('date, sent_at, article_count, email_html')
      .order('date', { ascending: false })
      .limit(limit);

    if (legacyResult.error) {
      throw new Error(`Failed to fetch recent digests: ${legacyResult.error.message}`);
    }

    return ((legacyResult.data ?? []) as Digest[]).map((item) => ({
      ...item,
      run_id: undefined,
      status: undefined,
    }));
  }

  if (modernResult.error) {
    throw new Error(`Failed to fetch recent digests: ${modernResult.error.message}`);
  }

  return (modernResult.data ?? []) as Digest[];
}

export async function getFallbackArticlesForDigest(
  query: FallbackQuery,
): Promise<Article[]> {
  if (query.limit <= 0) {
    return [];
  }

  const db = getClient();
  const rowsLimit = Math.max(query.limit, 1);

  const modernSelect = await db
    .from('articles')
    .select(
      'source,url,raw_url,canonical_url,title,content,summary,category,score,keywords,published_at,created_at',
    )
    .gte('score', query.minScore)
    .not('summary', 'is', null)
    .order('score', { ascending: false })
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(rowsLimit * 3);

  if (modernSelect.error && isMissingColumnError(modernSelect.error.code)) {
    const legacySelect = await db
      .from('articles')
      .select('source,url,title,content,summary,category,score,keywords,published_at,created_at')
      .gte('score', query.minScore)
      .not('summary', 'is', null)
      .order('score', { ascending: false })
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(rowsLimit * 3);

    if (legacySelect.error) {
      throw new Error(`Failed to fetch fallback articles: ${legacySelect.error.message}`);
    }

    const exclude = new Set(query.excludeUrls);
    const deduped: Article[] = [];

    for (const item of legacySelect.data ?? []) {
      const article = item as Article;
      if (exclude.has(article.url)) continue;
      if (deduped.some((existing) => existing.url === article.url)) continue;
      deduped.push(article);
      if (deduped.length >= rowsLimit) break;
    }

    return deduped;
  }

  if (modernSelect.error) {
    throw new Error(`Failed to fetch fallback articles: ${modernSelect.error.message}`);
  }

  const exclude = new Set(query.excludeUrls);
  const deduped: Article[] = [];

  for (const item of modernSelect.data ?? []) {
    const article = item as Article;
    const key = article.canonical_url ?? article.url;
    if (exclude.has(key)) continue;
    if (
      deduped.some((existing) => (existing.canonical_url ?? existing.url) === key)
    ) {
      continue;
    }
    deduped.push(article);
    if (deduped.length >= rowsLimit) break;
  }

  return deduped;
}
