import { describe, expect, it, vi } from 'vitest';

async function loadHealthModule() {
  vi.resetModules();
  process.env.AMZ_SKIP_HEALTH_AUTORUN = '1';
  return import('../health-check.js');
}

describe('evaluateChatCompletionResponse', () => {
  it('passes when the first choice has text content', async () => {
    const { evaluateChatCompletionResponse } = await loadHealthModule();

    const result = evaluateChatCompletionResponse({
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
    });

    expect(result).toEqual({
      ok: true,
      detail: 'Response: "OK"',
    });
  });

  it('passes when choices exist but content is empty', async () => {
    const { evaluateChatCompletionResponse } = await loadHealthModule();

    const result = evaluateChatCompletionResponse({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('choice');
    expect(result.detail).toContain('length');
  });

  it('fails when there are no choices at all', async () => {
    const { evaluateChatCompletionResponse } = await loadHealthModule();

    const result = evaluateChatCompletionResponse({ choices: [] });

    expect(result).toEqual({
      ok: false,
      detail: 'Empty response',
    });
  });
});