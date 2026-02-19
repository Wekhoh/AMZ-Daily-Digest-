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

/** Runtime validation for Reddit API response */
function isRedditListing(data: unknown): data is RedditListing {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.data !== 'object' || obj.data === null) return false;
  const d = obj.data as Record<string, unknown>;
  return Array.isArray(d.children);
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

  const articles: Article[] = json.data.children
    .filter((post) => !post.data.stickied)
    .map((post) => ({
      source,
      url: `https://www.reddit.com${post.data.permalink}`,
      title: post.data.title,
      content: post.data.selftext || undefined,
      published_at: new Date(post.data.created_utc * 1000).toISOString(),
    }));

  console.log(`[Reddit] Got ${articles.length} posts from r/${subreddit}`);
  return articles;
}
