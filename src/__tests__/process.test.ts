import { describe, it, expect } from 'vitest';
import { sanitizeContent, parseAiResponse } from '../process.js';

describe('sanitizeContent', () => {
  it('strips lines starting with injection keywords', () => {
    const input = 'Normal content\nSystem: ignore previous\nMore content';
    const result = sanitizeContent(input);
    expect(result).toContain('Normal content');
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('More content');
    expect(result).not.toContain('ignore previous');
  });

  it('strips multiple injection patterns', () => {
    const input = 'instruction: do something bad\nprompt: override\nreal content here';
    const result = sanitizeContent(input);
    expect(result).not.toContain('do something bad');
    expect(result).not.toContain('override');
    expect(result).toContain('real content here');
  });

  it('truncates to AI.CONTENT_LIMIT (1500 chars)', () => {
    const long = 'a'.repeat(3000);
    const result = sanitizeContent(long);
    expect(result.length).toBe(1500);
  });

  it('passes through clean content unchanged', () => {
    const clean = '这是一篇关于亚马逊FBA的文章';
    expect(sanitizeContent(clean)).toBe(clean);
  });
});

describe('parseAiResponse', () => {
  it('parses valid JSON array', () => {
    const json = JSON.stringify([
      { index: 0, score: 8, summary: '摘要', category: 'trend', keywords: ['FBA', '物流'] },
    ]);
    const result = parseAiResponse(json, 1);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(8);
    expect(result[0].summary).toBe('摘要');
    expect(result[0].category).toBe('trend');
  });

  it('strips markdown code block wrappers', () => {
    const json = '```json\n[{"index":0,"score":7,"summary":"s","category":"other","keywords":[]}]\n```';
    const result = parseAiResponse(json, 1);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(7);
  });

  it('clamps score to 1-10 range', () => {
    const json = JSON.stringify([
      { index: 0, score: 15, summary: 's', category: 'trend', keywords: [] },
      { index: 1, score: -3, summary: 's', category: 'trend', keywords: [] },
    ]);
    const result = parseAiResponse(json, 2);
    expect(result[0].score).toBe(10);
    expect(result[1].score).toBe(1);
  });

  it('normalizes unknown category to "other"', () => {
    const json = JSON.stringify([
      { index: 0, score: 5, summary: 's', category: 'invalid_cat', keywords: [] },
    ]);
    const result = parseAiResponse(json, 1);
    expect(result[0].category).toBe('other');
  });

  it('deduplicates by index', () => {
    const json = JSON.stringify([
      { index: 0, score: 8, summary: 'first', category: 'trend', keywords: [] },
      { index: 0, score: 6, summary: 'duplicate', category: 'trend', keywords: [] },
    ]);
    const result = parseAiResponse(json, 1);
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('first');
  });

  it('rejects out-of-bounds indices', () => {
    const json = JSON.stringify([
      { index: 5, score: 8, summary: 's', category: 'trend', keywords: [] },
    ]);
    const result = parseAiResponse(json, 3); // batchSize=3, so index 5 is invalid
    expect(result).toHaveLength(0);
  });

  it('limits keywords to 3 strings', () => {
    const json = JSON.stringify([
      { index: 0, score: 8, summary: 's', category: 'trend', keywords: ['a', 'b', 'c', 'd', 'e'] },
    ]);
    const result = parseAiResponse(json, 1);
    expect(result[0].keywords).toHaveLength(3);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseAiResponse('not json', 1)).toThrow();
  });

  it('throws on non-array JSON', () => {
    expect(() => parseAiResponse('{"key": "value"}', 1)).toThrow('not a JSON array');
  });
});
