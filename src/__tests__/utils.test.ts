import { describe, it, expect } from 'vitest';
import { isSafeUrl, sleep, canonicalizeUrl } from '../utils.js';

describe('isSafeUrl', () => {
  const domains = ['wearesellers.com', 'reddit.com'];

  it('allows exact domain match', () => {
    expect(isSafeUrl('https://wearesellers.com/page', domains)).toBe(true);
  });

  it('allows subdomain match', () => {
    expect(isSafeUrl('https://www.wearesellers.com/page', domains)).toBe(true);
    expect(isSafeUrl('https://api.reddit.com/data', domains)).toBe(true);
  });

  it('rejects domain suffix bypass (SSRF)', () => {
    // evil-wearesellers.com should NOT match wearesellers.com
    expect(isSafeUrl('https://evil-wearesellers.com/steal', domains)).toBe(false);
    expect(isSafeUrl('https://notreddit.com/fake', domains)).toBe(false);
  });

  it('rejects non-http protocols', () => {
    expect(isSafeUrl('javascript:alert(1)', domains)).toBe(false);
    expect(isSafeUrl('file:///etc/passwd', domains)).toBe(false);
    expect(isSafeUrl('data:text/html,<h1>hi</h1>', domains)).toBe(false);
    expect(isSafeUrl('ftp://wearesellers.com/file', domains)).toBe(false);
  });

  it('allows http protocol', () => {
    expect(isSafeUrl('http://wearesellers.com/page', domains)).toBe(true);
  });

  it('rejects invalid URLs', () => {
    expect(isSafeUrl('not-a-url', domains)).toBe(false);
    expect(isSafeUrl('', domains)).toBe(false);
  });

  it('rejects when domain list is empty', () => {
    expect(isSafeUrl('https://example.com', [])).toBe(false);
  });
});

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow small timing variance
  });
});

describe('canonicalizeUrl', () => {
  it('removes tracking params and hash', () => {
    expect(
      canonicalizeUrl('https://Example.com/path/?utm_source=x&b=2&a=1#top')
    ).toBe('https://example.com/path?a=1&b=2');
  });

  it('removes trailing slash except root', () => {
    expect(canonicalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('returns null for non-http protocols and invalid URLs', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('not-a-url')).toBeNull();
  });
});
