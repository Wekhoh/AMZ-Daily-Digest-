import { afterEach, describe, expect, it, vi } from 'vitest';

interface LocatorLike {
  count: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
}

function createLoginCheckPage(loginCount: number): {
  goto: ReturnType<typeof vi.fn>;
  locator: ReturnType<typeof vi.fn>;
} {
  const goto = vi.fn().mockResolvedValue(undefined);
  const locator = vi.fn((selector: string): LocatorLike => {
    const counts: Record<string, number> = {
      '.aw-user-name': 0,
      'a[href*="logout"]': 0,
      'a[href*="login"]': loginCount,
    };
    return {
      count: vi.fn().mockResolvedValue(counts[selector] ?? 0),
      first: vi.fn(() => ({
        textContent: vi.fn().mockResolvedValue(''),
        getAttribute: vi.fn().mockResolvedValue(''),
      })),
    };
  });

  return { goto, locator };
}

async function loadWeAreSellersCollector(loginCount = 1) {
  vi.resetModules();
  const page = createLoginCheckPage(loginCount);
  const addCookies = vi.fn().mockResolvedValue(undefined);
  const contextClose = vi.fn().mockResolvedValue(undefined);
  const browserClose = vi.fn().mockResolvedValue(undefined);

  const context = {
    addCookies,
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

  const mod = await import('../collectors/wearesellers.js');
  return {
    collectWeAreSellers: mod.collectWeAreSellers as () => Promise<unknown[]>,
    launch,
    addCookies,
    contextClose,
    browserClose,
    page,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.WEARESELLERS_COOKIES;
});

describe('collectWeAreSellers', () => {
  it('throws when WEARESELLERS_COOKIES is missing', async () => {
    const { collectWeAreSellers } = await loadWeAreSellersCollector();
    delete process.env.WEARESELLERS_COOKIES;

    await expect(collectWeAreSellers()).rejects.toThrow(
      'Missing WEARESELLERS_COOKIES env var',
    );
  });

  it('returns empty array when login check indicates not authenticated', async () => {
    process.env.WEARESELLERS_COOKIES = JSON.stringify([
      {
        name: 'sessionid',
        value: 'abc',
        domain: '.wearesellers.com',
        path: '/',
      },
    ]);

    const {
      collectWeAreSellers,
      launch,
      addCookies,
      contextClose,
      browserClose,
      page,
    } = await loadWeAreSellersCollector(1);

    const result = await collectWeAreSellers();

    expect(result).toEqual([]);
    expect(launch).toHaveBeenCalledWith({ headless: true });
    expect(addCookies).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith('https://www.wearesellers.com', {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    expect(contextClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });
});
