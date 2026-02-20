import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectReddit } from '../collectors/reddit.js';

function createJsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    json: async () => payload,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('collectReddit', () => {
  it('collects posts from both subreddits and filters stickied posts', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/FulfillmentByAmazon/')) {
        return createJsonResponse({
          data: {
            children: [
              {
                data: {
                  title: 'FBA Post',
                  permalink: '/r/FulfillmentByAmazon/comments/1/fba_post',
                  selftext: 'fba body',
                  created_utc: 1_700_000_000,
                  stickied: false,
                  url: 'https://example.com/fba',
                },
              },
              {
                data: {
                  title: 'Pinned',
                  permalink: '/r/FulfillmentByAmazon/comments/2/pinned',
                  selftext: '',
                  created_utc: 1_700_000_001,
                  stickied: true,
                  url: 'https://example.com/pinned',
                },
              },
            ],
          },
        });
      }

      if (url.includes('/comments/3/seller_post.json')) {
        return createJsonResponse([
          { data: { children: [] } },
          {
            data: {
              children: [
                {
                  data: {
                    body: 'Use exact match negatives before broad expansion to cut wasted spend.',
                    stickied: false,
                    author: 'sellerA',
                  },
                },
                {
                  data: {
                    body: 'Track week-over-week TACoS and only scale ad sets that keep margin.',
                    stickied: false,
                    author: 'sellerB',
                  },
                },
              ],
            },
          },
        ]);
      }

      return createJsonResponse({
        data: {
          children: [
            {
              data: {
                title: 'Seller Post',
                permalink: '/r/AmazonSeller/comments/3/seller_post',
                selftext: '',
                created_utc: 1_700_000_100,
                stickied: false,
                url: 'https://example.com/seller',
              },
            },
          ],
        },
      });
    });

    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const articles = await collectReddit();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(articles).toHaveLength(2);
    expect(articles[0]).toMatchObject({
      source: 'reddit_fba',
      title: 'FBA Post',
      url: 'https://www.reddit.com/r/FulfillmentByAmazon/comments/1/fba_post',
      content: 'fba body',
    });
    expect(articles[1]).toMatchObject({
      source: 'reddit_seller',
      title: 'Seller Post',
      url: 'https://www.reddit.com/r/AmazonSeller/comments/3/seller_post',
    });
    expect(articles[1].content).toContain('Use exact match negatives');
    expect(articles[1].content).toContain('Track week-over-week TACoS');
  });

  it('retries failing subreddit and continues with other sources', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/FulfillmentByAmazon/')) {
        throw new Error('network down');
      }
      return createJsonResponse({
        data: {
          children: [
            {
              data: {
                title: 'Recovered Seller Post',
                permalink: '/r/AmazonSeller/comments/9/recovered',
                selftext: 'seller body',
                created_utc: 1_700_000_500,
                stickied: false,
                url: 'https://example.com/recovered',
              },
            },
          ],
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((handler: TimerHandler) => {
        if (typeof handler === 'function') {
          handler();
        }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const articles = await collectReddit();

    // FulfillmentByAmazon fails 3 attempts, AmazonSeller succeeds 1 attempt.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(timeoutSpy).toHaveBeenCalled();
    expect(articles).toHaveLength(1);
    expect(articles[0].source).toBe('reddit_seller');
    expect(articles[0].title).toBe('Recovered Seller Post');
  });

  it('keeps post when comment fetch fails', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (url.includes('/hot.json')) {
        return createJsonResponse({
          data: {
            children: [
              {
                data: {
                  title: 'Need listing advice',
                  permalink: '/r/AmazonSeller/comments/55/listing_advice',
                  selftext: '',
                  created_utc: 1_700_001_000,
                  stickied: false,
                  url: 'https://example.com/listing_advice',
                },
              },
            ],
          },
        });
      }

      if (url.includes('/comments/55/listing_advice.json')) {
        throw new Error('comments endpoint timeout');
      }

      return createJsonResponse({ data: { children: [] } });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const articles = await collectReddit();

    expect(fetchMock).toHaveBeenCalled();
    expect(articles.length).toBeGreaterThan(0);
    expect(articles[0].title).toBe('Need listing advice');
  });
});
