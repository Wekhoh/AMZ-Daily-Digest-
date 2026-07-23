import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDigestDoc,
  writeDigestJson,
  DIGEST_SCHEMA_VERSION,
  MAX_PUBLISHED_ARTICLES,
} from '../publish.js';
import type { Article } from '../store.js';

function article(over: Partial<Article> = {}): Article {
  return {
    source: 'reddit_fba',
    url: 'https://example.test/1',
    title: 't',
    summary: 's',
    category: 'policy',
    score: 5,
    ...over,
  };
}

describe('buildDigestDoc', () => {
  it('emits the schema-1 contract with the full count and top-N articles', () => {
    const articles = Array.from({ length: 15 }, (_, i) =>
      article({ url: `https://example.test/${i}`, title: `t${i}`, score: i }),
    );
    const doc = buildDigestDoc(articles, '2026-07-23', new Date('2026-07-23T06:00:00.000Z'));

    expect(doc.schema_version).toBe(DIGEST_SCHEMA_VERSION);
    expect(doc.digest_date).toBe('2026-07-23');
    expect(doc.generated_at_utc).toBe('2026-07-23T06:00:00Z');
    expect(doc.article_count).toBe(15);
    expect(doc.articles).toHaveLength(MAX_PUBLISHED_ARTICLES);
    const scores = doc.articles.map((a) => a.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    expect(scores[0]).toBe(14);
  });

  it('whitelists fields and normalizes unknown categories to "other"', () => {
    const doc = buildDigestDoc(
      [article({ category: 'weird', canonical_url: 'https://canon.test/1', published_at: undefined })],
      '2026-07-23',
    );
    const a = doc.articles[0];
    expect(Object.keys(a).sort()).toEqual([
      'category',
      'published_at',
      'score',
      'source',
      'summary',
      'title',
      'url',
    ]);
    expect(a.category).toBe('other');
    expect(a.url).toBe('https://canon.test/1');
    expect(a.published_at).toBeNull();
  });

  it('handles a zero-news day (empty articles list)', () => {
    const doc = buildDigestDoc([], '2026-07-23');
    expect(doc.article_count).toBe(0);
    expect(doc.articles).toEqual([]);
  });
});

describe('writeDigestJson', () => {
  it('writes parseable JSON with a trailing newline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'digest-publish-'));
    const path = join(dir, 'public', 'digest-latest.json');
    try {
      const doc = await writeDigestJson([article()], '2026-07-23', path);
      const raw = await readFile(path, 'utf-8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(JSON.parse(raw)).toEqual(doc);
      expect(JSON.parse(raw).schema_version).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
