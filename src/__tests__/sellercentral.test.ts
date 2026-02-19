import { afterEach, describe, expect, it, vi } from 'vitest';

function createPageForLoginWall(blogPosts: Array<{ title: string; url: string; snippet: string }>) {
  let currentUrl = 'https://sellercentral.amazon.com/seller-forums';
  const goto = vi.fn(async (url: string) => {
    if (url.includes('seller-forums')) {
      currentUrl = 'https://sellercentral.amazon.com/ap/signin';
      return;
    }
    if (url.includes('/blog')) {
      currentUrl = 'https://sell.amazon.com/blog';
      return;
    }
    currentUrl = url;
  });

  const locator = vi.fn(() => ({
    first: vi.fn(() => ({
      waitFor: vi.fn().mockResolvedValue(undefined),
    })),
  }));

  const evaluate = vi.fn().mockResolvedValue(blogPosts);

  return {
    goto,
    url: vi.fn(() => currentUrl),
    locator,
    evaluate,
  };
}

async function loadSellerCentralCollectorWithPage(page: ReturnType<typeof createPageForLoginWall>) {
  vi.resetModules();

  const contextClose = vi.fn().mockResolvedValue(undefined);
  const browserClose = vi.fn().mockResolvedValue(undefined);
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    close: contextClose,
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: browserClose,
  };
  const launch = vi.fn().mockResolvedValue(browser);

  vi.doMock('playwright', () => ({
    chromium: { launch },
  }));

  const mod = await import('../collectors/sellercentral.js');

  return {
    collectSellerCentral: mod.collectSellerCentral as () => Promise<unknown[]>,
    launch,
    contextClose,
    browserClose,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collectSellerCentral', () => {
  it('falls back to seller blog when login wall is detected and filters unsafe/duplicate URLs', async () => {
    const page = createPageForLoginWall([
      {
        title: 'Valid Blog Post',
        url: 'https://sell.amazon.com/blog/post-1',
        snippet: 'good snippet',
      },
      {
        title: 'Valid Blog Post',
        url: 'https://sell.amazon.com/blog/post-1',
        snippet: 'duplicate',
      },
      {
        title: 'Unsafe Blog Post',
        url: 'https://evil.example.com/fake',
        snippet: 'unsafe',
      },
    ]);

    const { collectSellerCentral, launch, contextClose, browserClose } =
      await loadSellerCentralCollectorWithPage(page);

    const articles = await collectSellerCentral();

    expect(launch).toHaveBeenCalledWith({ headless: true });
    expect(page.goto).toHaveBeenCalledWith(
      'https://sellercentral.amazon.com/seller-forums',
      expect.objectContaining({
        waitUntil: 'domcontentloaded',
      }),
    );
    expect(page.goto).toHaveBeenCalledWith(
      'https://sell.amazon.com/blog',
      expect.objectContaining({
        waitUntil: 'domcontentloaded',
      }),
    );
    expect(articles).toEqual([
      expect.objectContaining({
        source: 'sellercentral',
        title: 'Valid Blog Post',
        url: 'https://sell.amazon.com/blog/post-1',
      }),
    ]);
    expect(contextClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when browser launch fails', async () => {
    vi.resetModules();
    const launch = vi.fn().mockRejectedValue(new Error('launch failed'));
    vi.doMock('playwright', () => ({
      chromium: { launch },
    }));

    const mod = await import('../collectors/sellercentral.js');
    const articles = await mod.collectSellerCentral();

    expect(launch).toHaveBeenCalledTimes(1);
    expect(articles).toEqual([]);
  });
});
