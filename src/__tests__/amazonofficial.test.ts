import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '../store.js';

interface FeedItem {
  title?: string;
  link?: string;
  contentSnippet?: string;
  content?: string;
  isoDate?: string;
  pubDate?: string;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
}

async function loadOfficialCollector(
  parseURLImpl: (url: string) => Promise<{ items: FeedItem[] }>,
) {
  vi.resetModules();

  const parseURL = vi.fn(parseURLImpl);
  const ParserMock = vi.fn(function MockParser(this: { parseURL: typeof parseURL }) {
    this.parseURL = parseURL;
  });

  vi.doMock('rss-parser', () => ({
    default: ParserMock,
  }));

  const mod = await import('../collectors/amazonofficial.js');
  return {
    collectAmazonOfficial: mod.collectAmazonOfficial as () => Promise<Article[]>,
    parseURL,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collectAmazonOfficial', () => {
  it('maps changelog items and repairs the feed link host', async () => {
    const { collectAmazonOfficial, parseURL } = await loadOfficialCollector(async () => ({
      items: [
        {
          title: 'SP-API Updates: Acceptable Use Policy changes',
          link: 'https://developer-docs.amazon/sp-api/changelog/aup-changes',
          contentSnippet: 'This week updates the Acceptable Use Policy.',
          isoDate: daysAgoIso(1),
        },
      ],
    }));

    const articles = await collectAmazonOfficial();

    expect(String(parseURL.mock.calls[0][0])).toBe(
      'https://developer-docs.amazon.com/sp-api/changelog.rss',
    );
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      source: 'amazon_official',
      title: 'SP-API Updates: Acceptable Use Policy changes',
      url: 'https://developer-docs.amazon.com/sp-api/changelog/aup-changes',
      content: 'This week updates the Acceptable Use Policy.',
    });
    expect(articles[0].published_at).toBeTruthy();
  });

  it('drops archive items outside the freshness window', async () => {
    const { collectAmazonOfficial } = await loadOfficialCollector(async () => ({
      items: [
        {
          title: 'Fresh update',
          link: 'https://developer-docs.amazon/sp-api/changelog/fresh',
          isoDate: daysAgoIso(2),
        },
        {
          title: 'Archived 2022 update',
          link: 'https://developer-docs.amazon/sp-api/changelog/archived',
          isoDate: daysAgoIso(400),
        },
        {
          title: 'Undated update',
          link: 'https://developer-docs.amazon/sp-api/changelog/undated',
        },
      ],
    }));

    const articles = await collectAmazonOfficial();

    expect(articles.map((a) => a.title)).toEqual(['Fresh update']);
  });

  it('rejects items whose link leaves the official docs domain', async () => {
    const { collectAmazonOfficial } = await loadOfficialCollector(async () => ({
      items: [
        {
          title: 'Spoofed update',
          link: 'https://developer-docs.amazon.com.evil.example/sp-api/changelog/spoof',
          isoDate: daysAgoIso(1),
        },
        {
          title: 'Real update',
          link: 'https://developer-docs.amazon.com/sp-api/changelog/real',
          isoDate: daysAgoIso(1),
        },
      ],
    }));

    const articles = await collectAmazonOfficial();

    expect(articles.map((a) => a.title)).toEqual(['Real update']);
  });

  it('caps the number of collected items', async () => {
    const { collectAmazonOfficial } = await loadOfficialCollector(async () => ({
      items: Array.from({ length: 40 }, (_, index) => ({
        title: `Update ${index}`,
        link: `https://developer-docs.amazon/sp-api/changelog/update-${index}`,
        isoDate: daysAgoIso(1),
      })),
    }));

    const articles = await collectAmazonOfficial();

    expect(articles.length).toBeLessThanOrEqual(10);
    expect(articles[0].title).toBe('Update 0');
  });

  it('returns an empty array when the feed fails', async () => {
    const { collectAmazonOfficial, parseURL } = await loadOfficialCollector(async () => {
      throw new Error('feed unreachable');
    });

    const articles = await collectAmazonOfficial();

    expect(parseURL).toHaveBeenCalledTimes(1);
    expect(articles).toEqual([]);
  });
});
