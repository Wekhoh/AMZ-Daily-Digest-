import { afterEach, describe, expect, it, vi } from 'vitest';

interface FeedItem {
  title?: string;
  link?: string;
  contentSnippet?: string;
  content?: string;
  isoDate?: string;
  pubDate?: string;
}

async function loadRssCollector(parseURLImpl: (url: string) => Promise<{ items: FeedItem[] }>) {
  vi.resetModules();

  const parseURL = vi.fn(parseURLImpl);
  const ParserMock = vi.fn(function MockParser(this: { parseURL: typeof parseURL }) {
    this.parseURL = parseURL;
  });

  vi.doMock('rss-parser', () => ({
    default: ParserMock,
  }));

  const mod = await import('../collectors/rss.js');
  return {
    collectRSS: mod.collectRSS as () => Promise<Array<{ url: string; title: string; source: string }>>,
    parseURL,
    ParserMock,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collectRSS', () => {
  it('filters unsafe/invalid items and maps valid AMZ123 articles', async () => {
    const { collectRSS, parseURL, ParserMock } = await loadRssCollector(
      async () => ({
        items: [
          {
            title: 'Valid news',
            link: 'https://www.amz123.com/news/1?utm_source=test',
            contentSnippet: 'snippet',
            isoDate: '2026-02-01T00:00:00Z',
          },
          {
            title: 'Unsafe news',
            link: 'https://evil.example.com/phishing',
          },
          {
            title: '',
            link: 'https://www.amz123.com/news/2',
          },
        ],
      }),
    );

    const articles = await collectRSS();

    expect(ParserMock).toHaveBeenCalledTimes(1);
    expect(parseURL).toHaveBeenCalledTimes(1);
    expect(String(parseURL.mock.calls[0][0])).toContain('rsshub.rssforever.com');
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      source: 'amz123',
      title: 'Valid news',
      url: 'https://www.amz123.com/news/1?utm_source=test',
    });
  });

  it('falls back to next RSSHub endpoint when earlier ones fail', async () => {
    const { collectRSS, parseURL } = await loadRssCollector(async (url) => {
      if (url.includes('rssforever.com') || url.includes('rsshub.app')) {
        throw new Error('temporary outage');
      }
      return {
        items: [
          {
            title: 'Recovered feed',
            link: 'https://amz123.com/news/recovered',
          },
        ],
      };
    });

    const articles = await collectRSS();

    expect(parseURL).toHaveBeenCalledTimes(3);
    expect(String(parseURL.mock.calls[2][0])).toContain('rsshub.pseudoyu.com');
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe('Recovered feed');
  });

  it('returns empty array when all RSSHub endpoints fail', async () => {
    const { collectRSS, parseURL } = await loadRssCollector(async () => {
      throw new Error('all feeds down');
    });

    const articles = await collectRSS();

    expect(parseURL).toHaveBeenCalledTimes(5);
    expect(articles).toEqual([]);
  });
});
