import { chromium } from 'playwright';
import type { Article } from '../store.js';
import { isSafeUrl, sleep } from '../utils.js';
import { COLLECTORS } from '../config.js';

const BASE_URL = 'https://www.wearesellers.com';

// ---------------------------------------------------------------------------
// Cookie handling
// ---------------------------------------------------------------------------

interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

function parseCookies(): PlaywrightCookie[] {
  const raw = process.env.WEARESELLERS_COOKIES;
  if (!raw) {
    throw new Error('Missing WEARESELLERS_COOKIES env var');
  }
  try {
    const cookies: unknown = JSON.parse(raw);
    if (!Array.isArray(cookies)) {
      throw new Error('WEARESELLERS_COOKIES must be a JSON array');
    }
    // Validate required fields on each cookie
    for (const c of cookies) {
      if (typeof c !== 'object' || c === null) {
        throw new Error('Each cookie must be an object');
      }
      const obj = c as Record<string, unknown>;
      if (typeof obj.name !== 'string' || !obj.name) {
        throw new Error('Cookie missing required "name" field');
      }
      if (typeof obj.value !== 'string') {
        throw new Error(`Cookie "${obj.name}" missing required "value" field`);
      }
      if (typeof obj.domain !== 'string' || !obj.domain) {
        throw new Error(`Cookie "${obj.name}" missing required "domain" field`);
      }
    }
    return cookies as PlaywrightCookie[];
  } catch (err) {
    throw new Error(`Invalid WEARESELLERS_COOKIES JSON: ${err}`, { cause: err });
  }
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

/**
 * Collect articles from 知无不言 (wearesellers.com)
 *
 * Verified against real DOM (2026-02-17):
 * - List page: `.aw-common-list .aw-item` contains post entries
 * - Title:     `h4 a` inside `.aw-question-content`
 * - Meta:      `.aw-question-content p` (category, author, views, time)
 * - Content:   NOT on list page — must visit detail page
 * - Detail:    `.markitup-box` on `/question/{id}` page
 * - Login:     `.aw-user-name` present when logged in
 *
 * Strategy:
 * 1. Scrape list page → titles + URLs (up to MAX_LIST)
 * 2. Visit top MAX_DETAIL detail pages → extract full post content via `.markitup-box`
 * 3. Polite delay between detail requests to avoid rate limiting
 */
export async function collectWeAreSellers(): Promise<Article[]> {
  const cookies = parseCookies();
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    });

    try {
      await context.addCookies(cookies);
      const page = await context.newPage();

      // Step 1: Navigate to discovery page
      console.log('[WeAreSellers] Navigating to discovery page...');
      await page.goto(BASE_URL, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });

      // Step 2: Check login status
      const loggedIn = await checkLogin(page);
      if (!loggedIn) {
        console.warn('[WeAreSellers] Cookie expired or login invalid');
        return []; // main.ts sends alert email
      }
      console.log('[WeAreSellers] Login verified');

      // Step 3: Extract post list (titles + URLs)
      const postList = await extractPostList(page);
      console.log(`[WeAreSellers] Found ${postList.length} posts on list page`);

      if (postList.length === 0) {
        return [];
      }

      // Step 4: Fetch detail pages for full content (top N posts)
      const articles = await fetchPostDetails(page, postList);

      console.log(
        `[WeAreSellers] Collected ${articles.length} articles with content`,
      );
      return articles;
    } finally {
      await context.close();
    }
  } catch (err) {
    console.warn(
      '[WeAreSellers] Failed:',
      err instanceof Error ? err.message : err,
    );
    return [];
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Login check — verified: `.aw-user-name` appears 336 times when logged in
// ---------------------------------------------------------------------------

async function checkLogin(
  page: import('playwright').Page,
): Promise<boolean> {
  // Primary: .aw-user-name is the strongest signal (present many times when logged in)
  const userNameCount = await page.locator('.aw-user-name').count();
  if (userNameCount > 0) return true;

  // Secondary: logout link only appears when authenticated
  const logoutLinks = await page.locator('a[href*="logout"]').count();
  if (logoutLinks > 0) return true;

  // If login button exists → not logged in
  const loginBtn = await page.locator('a[href*="login"]').count();
  if (loginBtn > 0) return false;

  // No login indicators found — page may have loaded an error or empty state.
  // Default to false to avoid scraping garbage content.
  console.warn(
    '[WeAreSellers] No login indicators found, assuming not logged in',
  );
  return false;
}

// ---------------------------------------------------------------------------
// Step 3: Extract post list from discovery page
// Verified selector: `.aw-common-list .aw-item` (100 items on page)
// Title: `.aw-question-content h4 a` gives text + full URL
// Meta: `.aw-question-content p` gives "分类 . 作者 . N人关注 . N回复 . N浏览 . 时间"
// ---------------------------------------------------------------------------

interface PostListItem {
  title: string;
  url: string;
  meta: string;
}

async function extractPostList(
  page: import('playwright').Page,
): Promise<PostListItem[]> {
  const items = page.locator('.aw-common-list .aw-item');
  const count = await items.count();
  const limit = Math.min(count, COLLECTORS.WEARESELLERS_MAX_LIST);
  const posts: PostListItem[] = [];

  for (let i = 0; i < limit; i++) {
    try {
      const item = items.nth(i);

      // Title + URL
      const titleLink = item.locator('.aw-question-content h4 a').first();
      const title =
        (await titleLink.textContent({ timeout: 2000 }))?.trim() ?? '';
      const href = (await titleLink.getAttribute('href')) ?? '';

      if (!title || !href) continue;

      // Meta text (category, replies, views, time)
      let meta = '';
      try {
        const metaEl = item.locator('.aw-question-content p').first();
        meta = (await metaEl.textContent({ timeout: 1000 }))?.trim() ?? '';
      } catch {
        // meta not critical
      }

      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      posts.push({ title, url: fullUrl, meta });
    } catch {
      continue;
    }
  }

  return posts;
}

// ---------------------------------------------------------------------------
// Step 4: Visit detail pages to get full post content
// Verified selector: `.markitup-box` on detail page gives full post body
// ---------------------------------------------------------------------------

/** Extract relative time from meta string like "2 天前更新" or "2026-02-05 13:47更新" */
function parseTimeFromMeta(meta: string): string | undefined {
  // Match date format: 2026-02-05 13:47 — source is CST (UTC+8)
  const dateMatch = meta.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (dateMatch)
    return new Date(`${dateMatch[1]}T${dateMatch[2]}+08:00`).toISOString();

  // Match relative time: N 天前, N 小时前, etc.
  const relMatch = meta.match(/(\d+)\s*(分钟|小时|天|周|月)前/);
  if (relMatch) {
    const num = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const now = Date.now();
    const unitMs: Record<string, number> = {
      分钟: 60_000,
      小时: 3_600_000,
      天: 86_400_000,
      周: 604_800_000,
      月: 2_592_000_000,
    };
    return new Date(now - num * (unitMs[unit] ?? 86_400_000)).toISOString();
  }

  return undefined;
}

const ALLOWED_DOMAINS = ['wearesellers.com'];

async function fetchPostDetails(
  page: import('playwright').Page,
  postList: PostListItem[],
): Promise<Article[]> {
  const articles: Article[] = [];
  const detailLimit = Math.min(
    postList.length,
    COLLECTORS.WEARESELLERS_MAX_DETAIL,
  );

  console.log(
    `[WeAreSellers] Fetching content for top ${detailLimit} posts...`,
  );

  for (let i = 0; i < detailLimit; i++) {
    const post = postList[i];

    // SSRF protection: only navigate to known domains
    if (!isSafeUrl(post.url, ALLOWED_DOMAINS)) {
      console.warn(`[WeAreSellers] Skipping suspicious URL: ${post.url}`);
      continue;
    }

    try {
      // Navigate to detail page
      await page.goto(post.url, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });

      // Extract full content from .markitup-box
      let content = '';
      try {
        const contentEl = page.locator('.markitup-box').first();
        content =
          (await contentEl.textContent({ timeout: 5000 }))?.trim() ?? '';
      } catch {
        // Some posts may not have content (e.g., deleted)
      }

      articles.push({
        source: 'wearesellers',
        url: post.url,
        title: post.title,
        content: content.slice(0, 2000) || undefined, // Cap at 2000 chars
        published_at: parseTimeFromMeta(post.meta),
      });

      console.log(
        `[WeAreSellers] [${i + 1}/${detailLimit}] ${post.title.slice(0, 40)}...`,
      );

      // Polite delay to avoid rate limiting
      if (i < detailLimit - 1) {
        await sleep(COLLECTORS.WEARESELLERS_DETAIL_DELAY_MS);
      }
    } catch (err) {
      console.warn(
        `[WeAreSellers] Failed to fetch detail for: ${post.title.slice(0, 40)}`,
        err,
      );
      // Still add with title-only if detail fetch fails
      articles.push({
        source: 'wearesellers',
        url: post.url,
        title: post.title,
        published_at: parseTimeFromMeta(post.meta),
      });
    }
  }

  // Add remaining posts (beyond detail limit) with title only
  for (let i = detailLimit; i < postList.length; i++) {
    const post = postList[i];
    articles.push({
      source: 'wearesellers',
      url: post.url,
      title: post.title,
      published_at: parseTimeFromMeta(post.meta),
    });
  }

  return articles;
}
