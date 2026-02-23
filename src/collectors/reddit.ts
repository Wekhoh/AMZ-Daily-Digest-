import type { Article } from '../store.js';
import { COLLECTORS } from '../config.js';
import { isSafeUrl } from '../utils.js';

const SUBREDDITS = [
  { name: 'FulfillmentByAmazon', source: 'reddit_fba' },
  { name: 'AmazonSeller', source: 'reddit_seller' },
] as const;

const USER_AGENT = 'amz-daily-digest/1.0 (Node.js; educational project)';
const ALLOWED_REDDIT_DOMAINS = ['reddit.com', 'www.reddit.com', 'old.reddit.com'];

const REDDIT_JSON_ENDPOINT_BUILDERS = [
  (subreddit: string) =>
    `https://www.reddit.com/r/${subreddit}/hot.json?limit=${COLLECTORS.REDDIT_POSTS_PER_SUB}`,
  (subreddit: string) =>
    `https://api.reddit.com/r/${subreddit}/hot?limit=${COLLECTORS.REDDIT_POSTS_PER_SUB}`,
  (subreddit: string) =>
    `https://old.reddit.com/r/${subreddit}/hot.json?limit=${COLLECTORS.REDDIT_POSTS_PER_SUB}`,
] as const;

const REDDIT_ATOM_ENDPOINT_BUILDERS = [
  (subreddit: string) =>
    `https://www.reddit.com/r/${subreddit}/hot/.rss?limit=${COLLECTORS.REDDIT_POSTS_PER_SUB}`,
  (subreddit: string) =>
    `https://old.reddit.com/r/${subreddit}/hot/.rss?limit=${COLLECTORS.REDDIT_POSTS_PER_SUB}`,
] as const;

interface RedditPost {
  data: {
    title: string;
    permalink: string;
    selftext: string;
    created_utc: number;
    stickied: boolean;
    url: string;
  };
}

interface RedditListing {
  data: {
    children: RedditPost[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Runtime validation for Reddit API response */
function isRedditListing(data: unknown): data is RedditListing {
  if (!isRecord(data)) return false;
  if (!isRecord(data.data)) return false;
  return Array.isArray(data.data.children);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripCdata(text: string): string {
  const cdataMatch = text.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdataMatch ? cdataMatch[1] : text;
}

function decodeHtmlEntities(text: string): string {
  const namedEntityMap: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: '\'',
    nbsp: ' ',
  };

  return text
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-zA-Z]+);/g, (match, named: string) => namedEntityMap[named] ?? match);
}

function extractTagValue(block: string, tagName: string): string | undefined {
  const matcher = new RegExp(`<${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = block.match(matcher);
  if (!match) return undefined;
  return stripCdata(match[1]).trim();
}

function extractLinkHref(entry: string): string | undefined {
  const match = entry.match(/<link\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)')[^>]*\/?>/i);
  const href = match?.[1] ?? match?.[2];
  if (!href) return undefined;
  return decodeHtmlEntities(stripCdata(href)).trim();
}

function buildFallbackContent(contentHtml: string): string | undefined {
  const decoded = decodeHtmlEntities(contentHtml);
  const plainText = normalizeText(
    decoded
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\[(?:link|comments)\]/gi, ' ')
      .replace(/submitted by/gi, ' '),
  );
  return plainText ? plainText.slice(0, COLLECTORS.REDDIT_CONTENT_LIMIT) : undefined;
}

function toIsoOrUndefined(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseAtomFeed(xml: string): Array<{
  title: string;
  link: string;
  content?: string;
  published_at?: string;
}> {
  const entryMatches = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  const articles: Array<{
    title: string;
    link: string;
    content?: string;
    published_at?: string;
  }> = [];

  for (const entry of entryMatches) {
    const title = extractTagValue(entry, 'title');
    const link = extractLinkHref(entry);
    const contentRaw = extractTagValue(entry, 'content') ?? '';
    const published =
      extractTagValue(entry, 'published') ?? extractTagValue(entry, 'updated');

    if (!title || !link) continue;

    articles.push({
      title: decodeHtmlEntities(title),
      link,
      content: buildFallbackContent(contentRaw),
      published_at: toIsoOrUndefined(published),
    });
  }

  return articles;
}

function parseTopComments(payload: unknown): string[] {
  if (!Array.isArray(payload) || payload.length < 2) {
    return [];
  }

  const commentsListing = payload[1];
  if (!isRecord(commentsListing) || !isRecord(commentsListing.data)) {
    return [];
  }

  const children = commentsListing.data.children;
  if (!Array.isArray(children)) {
    return [];
  }

  const comments: string[] = [];

  for (const child of children) {
    if (!isRecord(child) || !isRecord(child.data)) continue;

    const body = typeof child.data.body === 'string'
      ? normalizeText(child.data.body)
      : '';
    const stickied = child.data.stickied === true;

    if (stickied) continue;
    if (body.length < COLLECTORS.REDDIT_COMMENT_MIN_CHARS) continue;

    comments.push(body);
    if (comments.length >= COLLECTORS.REDDIT_COMMENTS_PER_POST) {
      break;
    }
  }

  return comments;
}

function shouldEnrichWithComments(post: RedditPost, index: number): boolean {
  const selftextLength = post.data.selftext.trim().length;
  return (
    index < COLLECTORS.REDDIT_COMMENT_ENRICH_MAX_POSTS &&
    selftextLength < COLLECTORS.REDDIT_MIN_SELFTEXT_CHARS
  );
}

function buildContent(selftext: string, comments: string[]): string | undefined {
  const normalizedSelftext = normalizeText(selftext);
  if (comments.length === 0) {
    return normalizedSelftext || undefined;
  }

  const commentsBlock = comments
    .map((comment, idx) => `${idx + 1}. ${comment}`)
    .join('\n');

  const merged = normalizedSelftext
    ? `${normalizedSelftext}\n\n[Top comments]\n${commentsBlock}`
    : `[Top comments]\n${commentsBlock}`;

  return merged.slice(0, COLLECTORS.REDDIT_CONTENT_LIMIT);
}

async function fetchTopComments(permalink: string): Promise<string[]> {
  const commentsUrl =
    `https://www.reddit.com${permalink}.json` +
    `?sort=top&limit=${COLLECTORS.REDDIT_COMMENTS_PER_POST}`;

  const response = await fetch(commentsUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(COLLECTORS.REDDIT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const payload: unknown = await response.json();
  return parseTopComments(payload);
}

/**
 * Collect hot posts from Amazon-seller-related subreddits.
 * Filters out stickied posts. Returns empty array on failure.
 */
export async function collectReddit(): Promise<Article[]> {
  const allArticles: Article[] = [];

  for (const sub of SUBREDDITS) {
    let lastErr: unknown;
    for (
      let attempt = 0;
      attempt <= COLLECTORS.REDDIT_MAX_RETRIES;
      attempt++
    ) {
      try {
        const articles = await fetchSubreddit(sub.name, sub.source);
        allArticles.push(...articles);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[Reddit] r/${sub.name} attempt ${attempt + 1} failed: ${msg}`,
        );
        if (attempt < COLLECTORS.REDDIT_MAX_RETRIES) {
          await new Promise((r) =>
            setTimeout(r, COLLECTORS.REDDIT_RETRY_DELAY_MS * (attempt + 1)),
          );
        }
      }
    }
    if (lastErr) {
      console.warn(`[Reddit] r/${sub.name} JSON endpoints unavailable, trying Atom fallback...`);
      try {
        const fallbackArticles = await fetchSubredditViaAtom(sub.name, sub.source);
        allArticles.push(...fallbackArticles);
        lastErr = undefined;
        console.log(
          `[Reddit] r/${sub.name} Atom fallback recovered ${fallbackArticles.length} posts`,
        );
      } catch (fallbackErr) {
        const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        console.warn(`[Reddit] r/${sub.name} Atom fallback failed: ${msg}`);
      }
    }
    if (lastErr) {
      console.warn(
        `[Reddit] r/${sub.name} failed after ${COLLECTORS.REDDIT_MAX_RETRIES + 1} attempts, skipping`,
      );
    }
  }

  console.log(`[Reddit] Collected ${allArticles.length} articles total`);
  return allArticles;
}

async function fetchSubreddit(
  subreddit: string,
  source: string,
): Promise<Article[]> {
  console.log(`[Reddit] Fetching r/${subreddit}...`);

  const endpointErrors: string[] = [];
  let hadZeroResult = false;

  for (const buildUrl of REDDIT_JSON_ENDPOINT_BUILDERS) {
    const url = buildUrl(subreddit);
    try {
      const articles = await fetchSubredditFromJsonEndpoint(url, source, subreddit);
      if (articles.length > 0) {
        return articles;
      }
      hadZeroResult = true;
      endpointErrors.push(`${url} -> zero posts`);
      console.warn(`[Reddit] JSON endpoint returned 0 posts (${url}), trying next endpoint`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      endpointErrors.push(`${url} -> ${msg}`);
      console.warn(`[Reddit] JSON endpoint failed (${url}): ${msg}`);
    }
  }

  if (hadZeroResult) {
    throw new Error(`JSON endpoints returned zero posts for r/${subreddit}`);
  }

  throw new Error(`All JSON endpoints failed for r/${subreddit}: ${endpointErrors.join(' | ')}`);
}

async function fetchSubredditFromJsonEndpoint(
  url: string,
  source: string,
  subreddit: string,
): Promise<Article[]> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(COLLECTORS.REDDIT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const json: unknown = await response.json();
  if (!isRedditListing(json)) {
    throw new Error('Invalid Reddit API response structure');
  }

  const posts = json.data.children.filter((post) => !post.data.stickied);
  const articles: Article[] = [];

  for (let index = 0; index < posts.length; index++) {
    const post = posts[index];
    let comments: string[] = [];

    if (shouldEnrichWithComments(post, index)) {
      try {
        comments = await fetchTopComments(post.data.permalink);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[Reddit] Comments fetch failed for ${post.data.permalink}: ${msg}`,
        );
      }
    }

    articles.push({
      source,
      url: `https://www.reddit.com${post.data.permalink}`,
      title: post.data.title,
      content: buildContent(post.data.selftext || '', comments),
      published_at: new Date(post.data.created_utc * 1000).toISOString(),
    });
  }

  console.log(`[Reddit] Got ${articles.length} posts from r/${subreddit}`);
  return articles;
}

async function fetchSubredditViaAtom(
  subreddit: string,
  source: string,
): Promise<Article[]> {
  const endpointErrors: string[] = [];

  for (const buildUrl of REDDIT_ATOM_ENDPOINT_BUILDERS) {
    const atomUrl = buildUrl(subreddit);
    try {
      const response = await fetch(atomUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.1',
        },
        signal: AbortSignal.timeout(COLLECTORS.REDDIT_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const xml = await response.text();
      const entries = parseAtomFeed(xml).slice(0, COLLECTORS.REDDIT_POSTS_PER_SUB);

      const articles: Article[] = entries
        .filter((entry) => isSafeUrl(entry.link, ALLOWED_REDDIT_DOMAINS))
        .map((entry) => ({
          source,
          url: entry.link,
          title: entry.title,
          content: entry.content,
          published_at: entry.published_at,
        }));

      return articles;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      endpointErrors.push(`${atomUrl} -> ${msg}`);
      console.warn(`[Reddit] Atom endpoint failed (${atomUrl}): ${msg}`);
    }
  }

  throw new Error(`All Atom endpoints failed for r/${subreddit}: ${endpointErrors.join(' | ')}`);
}
