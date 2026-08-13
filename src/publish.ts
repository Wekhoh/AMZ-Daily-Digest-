import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Article } from './store.js';

/**
 * Machine-readable digest published for downstream consumers — primarily
 * amz-autopilot, which reads it over a credential-free HTTPS GET
 * (raw.githubusercontent) and renders a non-blocking news section in its daily
 * briefing. The shape is a HARD CONTRACT: keep it in lockstep with amz-autopilot
 * `src/amz_autopilot/sources/news.py` `parse_digest` (schema_version, digest_date,
 * articles[] with title/summary/category/score/url/source/published_at). Bump
 * DIGEST_SCHEMA_VERSION only alongside the consumer. The contract covers the
 * field shape, not the ordering: `articles` carries the head of the reranked
 * final selection.
 */
export const DIGEST_SCHEMA_VERSION = 1;
export const DIGEST_JSON_PATH = 'public/digest-latest.json';

/** How many articles off the head of the final selection reach consumers; the
 * full digest size is reported separately in `article_count`. Consumers show
 * fewer still (e.g. a card top-3). */
export const MAX_PUBLISHED_ARTICLES = 10;

const KNOWN_CATEGORIES = new Set(['policy', 'experience', 'trend', 'other']);

export interface PublishedArticle {
  title: string;
  summary: string;
  category: string;
  score: number;
  url: string;
  source: string;
  published_at: string | null;
}

export interface DigestDoc {
  schema_version: number;
  generated_at_utc: string;
  digest_date: string;
  article_count: number;
  articles: PublishedArticle[];
}

function isoSeconds(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Pure: build the published document from the final digest articles, keeping
 * their order. The incoming array is the reranked selection, so re-sorting here
 * would throw away the duplicate demotion and topic spread it encodes.
 */
export function buildDigestDoc(
  articles: Article[],
  digestDate: string,
  now = new Date(),
): DigestDoc {
  const top = articles
    .slice(0, MAX_PUBLISHED_ARTICLES)
    .map((a): PublishedArticle => ({
      title: a.title,
      summary: a.summary ?? '',
      category: KNOWN_CATEGORIES.has(a.category ?? '') ? (a.category as string) : 'other',
      score: a.score ?? 0,
      url: a.canonical_url ?? a.url,
      source: a.source,
      published_at: a.published_at ?? null,
    }));
  return {
    schema_version: DIGEST_SCHEMA_VERSION,
    generated_at_utc: isoSeconds(now),
    digest_date: digestDate,
    article_count: articles.length,
    articles: top,
  };
}

/**
 * Write the published document to `path` (default public/digest-latest.json),
 * creating the directory if needed. Returns the document written. The GitHub
 * Actions workflow commits this file so consumers can read it at a stable raw URL.
 */
export async function writeDigestJson(
  articles: Article[],
  digestDate: string,
  path = DIGEST_JSON_PATH,
): Promise<DigestDoc> {
  const doc = buildDigestDoc(articles, digestDate);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  return doc;
}
