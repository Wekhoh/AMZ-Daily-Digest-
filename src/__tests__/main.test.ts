import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '../store.js';

interface PipelineMocks {
  collectWeAreSellers: ReturnType<typeof vi.fn>;
  collectRSS: ReturnType<typeof vi.fn>;
  collectReddit: ReturnType<typeof vi.fn>;
  collectSellerCentral: ReturnType<typeof vi.fn>;
  processArticles: ReturnType<typeof vi.fn>;
  getExistingUrls: ReturnType<typeof vi.fn>;
  upsertArticles: ReturnType<typeof vi.fn>;
  saveDigest: ReturnType<typeof vi.fn>;
  getDigestByDate: ReturnType<typeof vi.fn>;
  acquireRunLock: ReturnType<typeof vi.fn>;
  markRunSent: ReturnType<typeof vi.fn>;
  markRunFailed: ReturnType<typeof vi.fn>;
  markRunSkipped: ReturnType<typeof vi.fn>;
  getActiveSubscribers: ReturnType<typeof vi.fn>;
  saveDigestDeliveries: ReturnType<typeof vi.fn>;
  generateEmailHtml: ReturnType<typeof vi.fn>;
  sendDigestEmail: ReturnType<typeof vi.fn>;
  sendAlertEmail: ReturnType<typeof vi.fn>;
}

const BASE_ARTICLE: Article = {
  source: 'rss',
  url: 'https://example.com/post?utm_source=test',
  title: 'Sample title',
};

function applyRequiredEnv(): void {
  process.env.AMZ_SKIP_MAIN_AUTORUN = '1';
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_KEY = 'test-supabase-key';
  process.env.GMAIL_USER = 'sender@example.com';
  process.env.GMAIL_APP_PASSWORD = 'test-password';
  process.env.DIGEST_EMAIL = 'digest@example.com';
  process.env.WEARESELLERS_COOKIES = '[{"name":"x","value":"y","domain":"wearesellers.com"}]';
}

async function loadMainWithMocks(
  overrides: Partial<PipelineMocks> = {},
): Promise<{
  runPipeline: () => Promise<void>;
  runPipelineWithTimeout: (timeoutMs?: number) => Promise<void>;
  mocks: PipelineMocks;
}> {
  vi.resetModules();
  applyRequiredEnv();

  const mocks: PipelineMocks = {
    collectWeAreSellers: vi.fn().mockResolvedValue([BASE_ARTICLE]),
    collectRSS: vi.fn().mockResolvedValue([]),
    collectReddit: vi.fn().mockResolvedValue([]),
    collectSellerCentral: vi.fn().mockResolvedValue([]),
    processArticles: vi.fn().mockResolvedValue([
      {
        ...BASE_ARTICLE,
        summary: '摘要',
        category: 'trend',
        score: 8,
        keywords: ['关键词1', '关键词2', '关键词3'],
      },
    ]),
    getExistingUrls: vi.fn().mockResolvedValue(new Set<string>()),
    upsertArticles: vi.fn().mockResolvedValue(1),
    saveDigest: vi.fn().mockResolvedValue(undefined),
    getDigestByDate: vi.fn().mockResolvedValue(null),
    acquireRunLock: vi.fn().mockResolvedValue(true),
    markRunSent: vi.fn().mockResolvedValue(undefined),
    markRunFailed: vi.fn().mockResolvedValue(undefined),
    markRunSkipped: vi.fn().mockResolvedValue(undefined),
    getActiveSubscribers: vi.fn().mockResolvedValue([]),
    saveDigestDeliveries: vi.fn().mockResolvedValue(undefined),
    generateEmailHtml: vi.fn().mockReturnValue('<html>digest</html>'),
    sendDigestEmail: vi.fn().mockResolvedValue({
      sent: [{ email: 'digest@example.com', messageId: 'msg-id' }],
      failed: [],
    }),
    sendAlertEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  vi.doMock('node:crypto', () => ({
    randomUUID: () => 'run-test-id',
  }));
  vi.doMock('../collectors/wearesellers.js', () => ({
    collectWeAreSellers: mocks.collectWeAreSellers,
  }));
  vi.doMock('../collectors/rss.js', () => ({
    collectRSS: mocks.collectRSS,
  }));
  vi.doMock('../collectors/reddit.js', () => ({
    collectReddit: mocks.collectReddit,
  }));
  vi.doMock('../collectors/sellercentral.js', () => ({
    collectSellerCentral: mocks.collectSellerCentral,
  }));
  vi.doMock('../process.js', () => ({
    processArticles: mocks.processArticles,
  }));
  vi.doMock('../store.js', () => ({
    getExistingUrls: mocks.getExistingUrls,
    upsertArticles: mocks.upsertArticles,
    saveDigest: mocks.saveDigest,
    getDigestByDate: mocks.getDigestByDate,
    acquireRunLock: mocks.acquireRunLock,
    markRunSent: mocks.markRunSent,
    markRunFailed: mocks.markRunFailed,
    markRunSkipped: mocks.markRunSkipped,
    getActiveSubscribers: mocks.getActiveSubscribers,
    saveDigestDeliveries: mocks.saveDigestDeliveries,
  }));
  vi.doMock('../email.js', () => ({
    generateEmailHtml: mocks.generateEmailHtml,
    sendDigestEmail: mocks.sendDigestEmail,
    sendAlertEmail: mocks.sendAlertEmail,
  }));

  const mod = await import('../main.js');
  return {
    runPipeline: mod.runPipeline as () => Promise<void>,
    runPipelineWithTimeout: mod.runPipelineWithTimeout as (timeoutMs?: number) => Promise<void>,
    mocks,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('runPipeline orchestration', () => {
  it('skips immediately when run lock is not acquired', async () => {
    const { runPipeline, mocks } = await loadMainWithMocks({
      acquireRunLock: vi.fn().mockResolvedValue(false),
    });

    await runPipeline();

    expect(mocks.getDigestByDate).not.toHaveBeenCalled();
    expect(mocks.collectWeAreSellers).not.toHaveBeenCalled();
    expect(mocks.markRunFailed).not.toHaveBeenCalled();
  });

  it('marks run skipped when no articles are collected', async () => {
    const { runPipeline, mocks } = await loadMainWithMocks({
      collectWeAreSellers: vi.fn().mockResolvedValue([]),
      collectRSS: vi.fn().mockResolvedValue([]),
      collectReddit: vi.fn().mockResolvedValue([]),
      collectSellerCentral: vi.fn().mockResolvedValue([]),
    });

    await runPipeline();

    expect(mocks.markRunSkipped).toHaveBeenCalledWith(
      'run-test-id',
      'No articles collected from any source',
    );
    expect(mocks.processArticles).not.toHaveBeenCalled();
  });

  it('sends and persists digest on happy path', async () => {
    const { runPipeline, mocks } = await loadMainWithMocks();

    await runPipeline();

    expect(mocks.sendDigestEmail).toHaveBeenCalledTimes(1);
    expect(mocks.saveDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: 'run-test-id',
        status: 'sent',
        article_count: 1,
      }),
    );
    expect(mocks.markRunSent).toHaveBeenCalledWith('run-test-id', 1);
    expect(mocks.markRunFailed).not.toHaveBeenCalled();
  });

  it('marks run failed when error happens before email is sent', async () => {
    const { runPipeline, mocks } = await loadMainWithMocks({
      sendDigestEmail: vi.fn().mockRejectedValue(new Error('SMTP unavailable')),
    });

    await expect(runPipeline()).rejects.toThrow('SMTP unavailable');

    expect(mocks.markRunFailed).toHaveBeenCalledWith(
      'run-test-id',
      'SMTP unavailable',
    );
    expect(mocks.markRunSent).not.toHaveBeenCalled();
  });

  it('marks run as sent with warning when post-send persistence fails', async () => {
    const { runPipeline, mocks } = await loadMainWithMocks({
      saveDigest: vi.fn().mockRejectedValue(new Error('save digest failed')),
    });

    await expect(runPipeline()).rejects.toThrow('save digest failed');

    expect(mocks.markRunSent).toHaveBeenCalledWith(
      'run-test-id',
      1,
      expect.stringContaining('Post-send warning: save digest failed'),
    );
    expect(mocks.markRunFailed).not.toHaveBeenCalled();
  });

  it('clears timeout timer when pipeline finishes before timeout', async () => {
    vi.useFakeTimers();
    try {
      const { runPipelineWithTimeout } = await loadMainWithMocks({
        acquireRunLock: vi.fn().mockResolvedValue(false),
      });

      await runPipelineWithTimeout(60_000);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
