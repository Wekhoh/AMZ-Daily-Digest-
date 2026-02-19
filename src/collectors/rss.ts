import Parser from 'rss-parser';
import type { Article } from '../store.js';
import { isSafeUrl } from '../utils.js';
import { COLLECTORS } from '../config.js';

// Try multiple RSSHub instances — public ones may rate-limit or block
const RSS_URLS = [
  'https://rsshub.rssforever.com/amz123/kx',
  'https://rsshub.app/amz123/kx',
  'https://rsshub.pseudoyu.com/amz123/kx',
  'https://rsshub.moeyy.xyz/amz123/kx',
  'https://hub.slarker.me/amz123/kx',
];

const ALLOWED_ARTICLE_DOMAINS = ['amz123.com', 'www.amz123.com'];

let _parser: Parser | null = null;

function getParser(): Parser {
  if (_parser) return _parser;
  _parser = new Parser({
    timeout: COLLECTORS.RSS_TIMEOUT_MS,
    headers: { 'User-Agent': 'amz-daily-digest/1.0' },
  });
  return _parser;
}

/**
 * Collect articles from AMZ123 快讯 via RSSHub.
 * Tries multiple RSSHub instances with fallback.
 * Returns up to MAX_ITEMS articles. Returns empty array on failure.
 */
export async function collectRSS(): Promise<Article[]> {
  for (const rssUrl of RSS_URLS) {
    try {
      console.log(`[RSS] Trying: ${rssUrl}`);

      const feed = await getParser().parseURL(rssUrl);

      const items = feed.items.slice(0, COLLECTORS.RSS_MAX_ITEMS);

      const articles: Article[] = items
        .filter((item) => {
          if (!item.title || !item.link) return false;
          if (!isSafeUrl(item.link, ALLOWED_ARTICLE_DOMAINS)) {
            console.warn(`[RSS] Rejected suspicious URL: ${item.link}`);
            return false;
          }
          return true;
        })
        .map((item) => ({
          source: 'amz123',
          url: item.link!,
          title: item.title!,
          content: item.contentSnippet ?? item.content ?? undefined,
          published_at: item.isoDate ?? item.pubDate ?? undefined,
        }));

      console.log(`[RSS] Collected ${articles.length} articles from AMZ123`);
      return articles;
    } catch (err) {
      console.warn(`[RSS] Failed with ${rssUrl}:`, err instanceof Error ? err.message : err);
    }
  }

  console.warn('[RSS] All RSSHub instances failed');
  return [];
}
