import { describe, it, expect } from 'vitest';
import { escapeHtml, sanitizeUrl } from '../email.js';

describe('escapeHtml', () => {
  it('escapes all dangerous HTML characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('escapes ampersand', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#x27;s');
  });

  it('passes through safe strings unchanged', () => {
    expect(escapeHtml('Hello World 123')).toBe('Hello World 123');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('handles Chinese characters without escaping', () => {
    expect(escapeHtml('亚马逊卖家')).toBe('亚马逊卖家');
  });
});

describe('sanitizeUrl', () => {
  it('allows https URLs', () => {
    expect(sanitizeUrl('https://example.com/path')).toBe('https://example.com/path');
  });

  it('allows http URLs', () => {
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com');
  });

  it('blocks javascript: protocol (XSS)', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('#');
  });

  it('blocks data: protocol', () => {
    expect(sanitizeUrl('data:text/html,<h1>evil</h1>')).toBe('#');
  });

  it('blocks file: protocol', () => {
    expect(sanitizeUrl('file:///etc/passwd')).toBe('#');
  });

  it('returns # for invalid URLs', () => {
    expect(sanitizeUrl('not-a-url')).toBe('#');
    expect(sanitizeUrl('')).toBe('#');
  });
});
