import type { Article } from '../store.js';
import { COLLECTORS } from '../config.js';

const SUBREDDITS = [
  { name: 'FulfillmentByAmazon', source: 'reddit_fba' },
  { name: 'AmazonSeller', source: 'reddit_seller' },
] as const;

const USER_AGENT = 'amz-daily-digest/1.0 (Node.js; educational project)';

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
  const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${COLLECTORS.REDDIT_POSTS_PER_SUB}`;

  console.log(`[Reddit] Fetching r/${subreddit}...`);

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
