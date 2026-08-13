import Parser from 'rss-parser';
import type { Article } from '../store.js';
import { isSafeUrl } from '../utils.js';
import { COLLECTORS } from '../config.js';

/**
 * Amazon official announcements. The SP-API changelog is the Amazon-operated
 * announcement channel that is public, machine-readable and login-free: it
 * carries policy updates (Acceptable Use Policy, Data Protection Policy),
 * store-level enforcement changes and listing attribute changes.
 *
 * Seller Central's own Seller News (/seller-news, /gp/headlines.html) answers
 * with a redirect to /ap/signin, so it is out of reach and must stay that way.
 */
const FEED_URL = 'https://developer-docs.amazon.com/sp-api/changelog.rss';

/**
 * Item links come back on Amazon's own `.amazon` gTLD host, which
 * developer-docs.amazon.com 301s to. Both hosts serve the article, but digest
 * links are normalized onto the conventional .com host so that every reader's
 * resolver and the allowlist below agree on them.
 */
const FEED_LINK_PREFIX = 'https://developer-docs.amazon/';
const DOCS_LINK_PREFIX = 'https://developer-docs.amazon.com/';

const ALLOWED_ARTICLE_DOMAINS = ['developer-docs.amazon.com'];

let _parser: Parser | null = null;

function getParser(): Parser {
  if (_parser) return _parser;
  _parser = new Parser({
    timeout: COLLECTORS.OFFICIAL_TIMEOUT_MS,
    headers: { 'User-Agent': 'amz-daily-digest/1.0' },
  });
  return _parser;
}

function repairLink(link: string): string {
  return link.startsWith(FEED_LINK_PREFIX)
    ? `${DOCS_LINK_PREFIX}${link.slice(FEED_LINK_PREFIX.length)}`
    : link;
}

/**
 * The feed ships its whole archive back to 2022. Without a window the first run
 * would push years of changelog entries through AI scoring into a daily digest,
 * and an item that cannot be dated cannot be shown to be news.
 */
function isRecent(rawDate: string | undefined, now: number): boolean {
  if (!rawDate) {
    return false;
  }
  const published = new Date(rawDate).getTime();
  if (Number.isNaN(published)) {
    return false;
  }
  return now - published <= COLLECTORS.OFFICIAL_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000;
}

/**
 * Collect recent Amazon official announcements.
 * Returns an empty array on any failure — the digest still ships without them.
 */
export async function collectAmazonOfficial(): Promise<Article[]> {
  try {
    console.log(`[AmazonOfficial] Fetching: ${FEED_URL}`);

    const feed = await getParser().parseURL(FEED_URL);
    const now = Date.now();
    const articles: Article[] = [];

    for (const item of feed.items) {
      if (articles.length >= COLLECTORS.OFFICIAL_MAX_ITEMS) {
        break;
      }
      if (!item.title || !item.link) {
        continue;
      }
      const publishedAt = item.isoDate ?? item.pubDate;
      if (!isRecent(publishedAt, now)) {
        continue;
      }

      const url = repairLink(item.link);
      if (!isSafeUrl(url, ALLOWED_ARTICLE_DOMAINS)) {
        console.warn(`[AmazonOfficial] Rejected suspicious URL: ${url}`);
        continue;
      }

      articles.push({
        source: 'amazon_official',
        url,
        title: item.title,
        content: item.contentSnippet ?? item.content ?? undefined,
        published_at: publishedAt,
      });
    }

    console.log(`[AmazonOfficial] Collected ${articles.length} official announcements`);
    return articles;
  } catch (err) {
    console.warn('[AmazonOfficial] Failed:', err instanceof Error ? err.message : err);
    return [];
  }
}
