import { describe, expect, it, vi } from 'vitest';

async function loadHealthModule() {
  vi.resetModules();
  process.env.AMZ_SKIP_HEALTH_AUTORUN = '1';
  return import('../health-check.js');
}

describe('evaluateGeminiResponse', () => {
  it('passes when response has text', async () => {
    const { evaluateGeminiResponse } = await loadHealthModule();

    const result = evaluateGeminiResponse({
      text: 'OK',
    });

    expect(result).toEqual({
      ok: true,
      detail: 'Response: "OK"',
    });
  });

  it('passes when response has candidates even without text', async () => {
    const { evaluateGeminiResponse } = await loadHealthModule();

    const result = evaluateGeminiResponse({
      text: '',
      candidates: [
        { finishReason: 'MAX_TOKENS' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('candidate');
    expect(result.detail).toContain('MAX_TOKENS');
  });

  it('fails when response has no text and no candidates', async () => {
    const { evaluateGeminiResponse } = await loadHealthModule();

    const result = evaluateGeminiResponse({
      text: '',
      candidates: [],
    });

    expect(result).toEqual({
      ok: false,
      detail: 'Empty response',
    });
  });
});
