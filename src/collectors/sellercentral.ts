import { chromium } from 'playwright';
import type { Article } from '../store.js';
import { isSafeUrl } from '../utils.js';
import { COLLECTORS } from '../config.js';

const FORUMS_URL = 'https://sellercentral.amazon.com/seller-forums';

/**
 * Collect articles from Amazon Seller Central Forums.
 *
 * Strategy:
 * 1. Navigate to Seller Central forums (public pages)
 * 2. Extract discussion titles + URLs from the listing
 * 3. If login wall is hit, gracefully return empty array
 *
 * Fallback: If forums are blocked, try the Amazon Seller blog.
 */
export async function collectSellerCentral(): Promise<Article[]> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    });

    try {
      const page = await context.newPage();

      // Try Seller Central Forums first
      console.log('[SellerCentral] Navigating to forums...');
      await page.goto(FORUMS_URL, {
        waitUntil: 'domcontentloaded',
        timeout: COLLECTORS.SC_TIMEOUT_MS,
      });

      const finalUrl = page.url();

      // Check if redirected to login page
      if (finalUrl.includes('/ap/signin') || finalUrl.includes('/login')) {
        console.warn('[SellerCentral] Login wall detected, trying seller blog...');
        return await collectSellerBlog(page);
      }

      // Try to extract forum discussions
      const articles = await extractForumPosts(page);

      if (articles.length > 0) {
        const enriched = await fetchPostContent(page, articles);
        console.log(`[SellerCentral] Collected ${enriched.length} articles from forums`);
        return enriched;
      }

      // Fallback to seller blog
      console.log('[SellerCentral] No forum posts found, trying seller blog...');
      return await collectSellerBlog(page);
    } finally {
      await context.close();
    }
  } catch (err) {
    console.warn('[SellerCentral] Failed:', err instanceof Error ? err.message : err);
    return [];
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Forum post extraction
// ---------------------------------------------------------------------------

const FORUM_ALLOWED_DOMAINS = ['amazon.com', 'sellercentral.amazon.com'];

async function extractForumPosts(
  page: import('playwright').Page
): Promise<Article[]> {
  const articles: Article[] = [];

  try {
    // Wait for forum content to load
    await page.locator('a[href*="/discussions/"], a[href*="/forums/"], .topic-list-item')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => { /* no forum elements found — fallback selectors below */ });

    // Try multiple selectors that Amazon forums might use
    const selectors = [
      'a.title[href*="/discussions/"]',
      'a.raw-topic-link',
      'a[href*="/seller-forums/discussions/"]',
      'a[href*="/forums/t/"]',
      '.topic-list-item a.title',
      '.discussion-title a',
      'h3 a[href*="forum"]',
      'h2 a[href*="forum"]',
    ];

    let links: Array<{ title: string; url: string }> = [];

    for (const selector of selectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        console.log(`[SellerCentral] Found ${count} posts with selector: ${selector}`);
        const elements = page.locator(selector);
        const limit = Math.min(count, COLLECTORS.SC_MAX_POSTS);

        for (let i = 0; i < limit; i++) {
          try {
            const el = elements.nth(i);
            const title = (await el.textContent({ timeout: 2000 }))?.trim() ?? '';
            const href = await el.getAttribute('href') ?? '';
            if (title && href) {
              const fullUrl = href.startsWith('http')
                ? href
                : `https://sellercentral.amazon.com${href}`;
              links.push({ title, url: fullUrl });
            }
          } catch {
            continue;
          }
        }
        if (links.length > 0) break;
      }
    }

    // Fallback: extract all links with discussion-like URLs
    if (links.length === 0) {
      const allLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]'))
          .filter((a) => {
            const href = a.getAttribute('href') ?? '';
            return (
              (href.includes('/discussions/') || href.includes('/forums/t/')) &&
              a.textContent &&
              a.textContent.trim().length > 10
            );
          })
          .slice(0, 30)
          .map((a) => ({
            title: (a.textContent ?? '').trim(),
            url: a.getAttribute('href') ?? '',
          }));
      });

      links = allLinks.map((l) => ({
        title: l.title,
        url: l.url.startsWith('http')
          ? l.url
          : `https://sellercentral.amazon.com${l.url}`,
      }));
    }

    for (const link of links) {
      if (!isSafeUrl(link.url, FORUM_ALLOWED_DOMAINS)) {
        console.warn(`[SellerCentral] Skipping suspicious forum URL: ${link.url}`);
        continue;
      }
      articles.push({
        source: 'sellercentral',
        url: link.url,
        title: link.title,
      });
    }
  } catch (err) {
    console.warn('[SellerCentral] Forum extraction failed:', err instanceof Error ? err.message : err);
  }

  return articles;
}

// ---------------------------------------------------------------------------
// Fetch detail page content — returns NEW array (does not mutate input)
// ---------------------------------------------------------------------------

async function fetchPostContent(
  page: import('playwright').Page,
  articles: Article[]
): Promise<Article[]> {
  console.log(`[SellerCentral] Fetching content for ${articles.length} posts...`);

  const results: Article[] = [];

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];

    // SSRF protection: only navigate to known domains
    if (!isSafeUrl(article.url, FORUM_ALLOWED_DOMAINS)) {
      console.warn(`[SellerCentral] Skipping suspicious URL: ${article.url}`);
      results.push(article);
      continue;
    }

    try {
      await page.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      // Wait for post content to load
      await page.locator('.discussion-body, .post-body, .message-body, main p')
        .first()
        .waitFor({ state: 'attached', timeout: 5_000 })
        .catch(() => { /* content selectors not found */ });

      // Try multiple selectors for post content
      const content = await page.evaluate(() => {
        const selectors = [
          '.discussion-body',
          '.post-body',
          '.message-body',
          '.topic-body',
          '[class*="post-content"]',
          '[class*="message-content"]',
          '[class*="discussion-content"]',
          'article .body',
          '.rich-text-content',
          'main p',
        ];

        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent && el.textContent.trim().length > 20) {
            return el.textContent.trim();
          }
        }

        const paragraphs = Array.from(document.querySelectorAll('main p, article p, .content p'));
        const text = paragraphs.map((p) => p.textContent?.trim()).filter(Boolean).join('\n');
        return text || '';
      });

      results.push(content
        ? { ...article, content: content.slice(0, 2000) }
        : article
      );

      console.log(
        `[SellerCentral] [${i + 1}/${articles.length}] ${article.title.slice(0, 40)}... ` +
        `(${content ? content.length + ' chars' : 'no content'})`
      );

      if (i < articles.length - 1) {
        await new Promise((r) => setTimeout(r, COLLECTORS.SC_DETAIL_DELAY_MS));
      }
    } catch (err) {
      console.warn(
        `[SellerCentral] Failed to fetch detail for: ${article.title.slice(0, 40)}`,
        err instanceof Error ? err.message : err
      );
      results.push(article);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Fallback: Amazon Seller Blog (always public)
// ---------------------------------------------------------------------------

const BLOG_URL = 'https://sell.amazon.com/blog';
const BLOG_ALLOWED_DOMAINS = ['sell.amazon.com', 'sellercentral.amazon.com', 'amazon.com'];

async function collectSellerBlog(
  page: import('playwright').Page
): Promise<Article[]> {
  const articles: Article[] = [];

  try {
    console.log('[SellerCentral] Navigating to seller blog...');
    await page.goto(BLOG_URL, {
      waitUntil: 'domcontentloaded',
      timeout: COLLECTORS.SC_TIMEOUT_MS,
    });

    // Wait for blog content to load
    await page
      .locator('article, .blog-post, [class*="blog"] a, .card')
      .first()
      .waitFor({ state: 'attached', timeout: 5_000 })
      .catch(() => { /* blog content may load via other selectors */ });

    // Extract blog post links
    const posts = await page.evaluate(() => {
      const results: Array<{ title: string; url: string; snippet: string }> = [];

      const articleEls = document.querySelectorAll(
        'article, .blog-post, .post-card, [class*="blog"] a, [class*="post"] a, .card a'
      );

      for (const el of Array.from(articleEls).slice(0, 30)) {
        const linkEl = el.tagName === 'A' ? el : el.querySelector('a');
        if (!linkEl) continue;

        const href = linkEl.getAttribute('href') ?? '';
        if (!href || href === '#') continue;

        const titleEl = el.querySelector('h1, h2, h3, h4') ?? linkEl;
        const title = (titleEl.textContent ?? '').trim();
        if (!title || title.length < 5) continue;

        const snippetEl = el.querySelector('p, .excerpt, .summary, .description');
        const snippet = (snippetEl?.textContent ?? '').trim();

        results.push({
          title,
          url: href.startsWith('http') ? href : `https://sell.amazon.com${href}`,
          snippet: snippet.slice(0, 500),
        });
      }

      return results;
    });

    // Deduplicate by URL with domain validation
    const seen = new Set<string>();
    for (const post of posts) {
      if (seen.has(post.url)) continue;
      if (!isSafeUrl(post.url, BLOG_ALLOWED_DOMAINS)) {
        console.warn(`[SellerCentral] Skipping unsafe blog URL: ${post.url}`);
        continue;
      }
      seen.add(post.url);

      articles.push({
        source: 'sellercentral',
        url: post.url,
        title: post.title,
        content: post.snippet || undefined,
      });
    }

    console.log(`[SellerCentral] Collected ${articles.length} articles from seller blog`);
  } catch (err) {
    console.warn('[SellerCentral] Blog scraping failed:', err instanceof Error ? err.message : err);
  }

  return articles;
}
