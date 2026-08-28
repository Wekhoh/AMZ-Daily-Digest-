import { describe, expect, it, vi } from 'vitest';

const openaiCreate = vi.hoisted(() => vi.fn());
const openaiConstruct = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: openaiCreate } };
    constructor(options: unknown) {
      openaiConstruct(options);
    }
  },
}));

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

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

describe('checkLlm', () => {
  it('pings the provider with a body GLM accepts', async () => {
    const previous = {
      key: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL,
      baseUrl: process.env.LLM_BASE_URL,
    };
    process.env.LLM_API_KEY = 'test-key';
    delete process.env.LLM_MODEL;
    delete process.env.LLM_BASE_URL;
    openaiCreate.mockReset();
    openaiConstruct.mockReset();
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
    });

    try {
      const { checkLlm } = await loadHealthModule();

      await checkLlm();

      expect(openaiConstruct).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'https://open.bigmodel.cn/api/paas/v4/' }),
      );
      expect(openaiCreate).toHaveBeenCalledTimes(1);
      const body = openaiCreate.mock.calls[0]?.[0];
      expect(body.model).toBe('glm-5.3-flash');
      // GLM-5.3 thinks unconditionally and rejects a request that asks it to
      // stop. This ping used to send {type:'disabled'} as its cheap mode, so it
      // is the one line a later "make the health check cheaper" change would
      // flip straight back into a rejected request on every run.
      expect(body.thinking).toEqual({ type: 'enabled' });
      expect(body.thinking?.type).not.toBe('disabled');
      // A connectivity ping buys no reasoning it does not need, and max_tokens
      // is what bounds the spend now that thinking cannot be turned off.
      expect(body.reasoning_effort).toBe('low');
      expect(body.max_tokens).toBeLessThanOrEqual(256);
    } finally {
      openaiCreate.mockReset();
      openaiConstruct.mockReset();
      restoreEnv('LLM_API_KEY', previous.key);
      restoreEnv('LLM_MODEL', previous.model);
      restoreEnv('LLM_BASE_URL', previous.baseUrl);
    }
  });
});