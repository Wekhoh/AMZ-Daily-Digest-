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
  getRecentRuns: ReturnType<typeof vi.fn>;
  getFallbackArticlesForDigest: ReturnType<typeof vi.fn>;
  getActiveSubscribers: ReturnType<typeof vi.fn>;
  saveDigestDeliveries: ReturnType<typeof vi.fn>;
  generateEmailHtml: ReturnType<typeof vi.fn>;
  sendDigestEmail: ReturnType<typeof vi.fn>;
  sendAlertEmail: ReturnType<typeof vi.fn>;
}

function makeScoredArticles(count: number, source = 'rss'): Article[] {
  return Array.from({ length: count }, (_, index) => ({
    source,
    url: `https://example.com/${source}/${index}`,
    title: `Sample ${source} title ${index}`,
    summary: `摘要 ${index}`,
    category: 'trend',
    score: 8,
    keywords: ['关键词1', '关键词2', '关键词3'],
  }));
}

const BASE_ARTICLE: Article = {
  source: 'rss',
  url: 'https://example.com/post?utm_source=test',
  title: 'Sample title',
};
const TODAY = new Date().toISOString().slice(0, 10);

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
    processArticles: vi.fn().mockResolvedValue(makeScoredArticles(30, 'rss')),
    getExistingUrls: vi.fn().mockResolvedValue(new Set<string>()),
    upsertArticles: vi.fn().mockResolvedValue(1),
    saveDigest: vi.fn().mockResolvedValue(undefined),
    getDigestByDate: vi.fn().mockResolvedValue(null),
    acquireRunLock: vi.fn().mockResolvedValue(true),
    markRunSent: vi.fn().mockResolvedValue(undefined),
    markRunFailed: vi.fn().mockResolvedValue(undefined),
    markRunSkipped: vi.fn().mockResolvedValue(undefined),
    getRecentRuns: vi.fn().mockResolvedValue([]),
    getFallbackArticlesForDigest: vi.fn().mockResolvedValue([]),
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
    getRecentRuns: mocks.getRecentRuns,
    getFallbackArticlesForDigest: mocks.getFallbackArticlesForDigest,
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

    expect(mocks.getDigestByDate).toHaveBeenCalledWith(TODAY);
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
        article_count: 30,
      }),
    );
    expect(mocks.markRunSent).toHaveBeenCalledWith('run-test-id', 30);
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
      30,
      expect.stringContaining('Post-send warning: save digest failed'),
    );
    expect(mocks.markRunFailed).not.toHaveBeenCalled();
  });

  it('fails before sending when final article count stays below minimum', async () => {
    const { runPipeline, mocks } = await loadMainWithMocks({
      processArticles: vi.fn().mockResolvedValue(makeScoredArticles(8, 'rss')),
      getFallbackArticlesForDigest: vi.fn().mockResolvedValue(
        makeScoredArticles(10, 'reddit_fba'),
      ),
    });

    await expect(runPipeline()).rejects.toThrow('below minimum');

    expect(mocks.getFallbackArticlesForDigest).toHaveBeenCalledTimes(1);
    expect(mocks.sendAlertEmail).toHaveBeenCalledWith(
      expect.stringContaining('below minimum'),
    );
    expect(mocks.sendDigestEmail).not.toHaveBeenCalled();
    expect(mocks.markRunFailed).toHaveBeenCalled();
  });

  it('tops up digest with fallback articles when fresh pool is insufficient', async () => {
    const { runPipeline, mocks } = await loadMainWithMocks({
      processArticles: vi.fn().mockResolvedValue(makeScoredArticles(12, 'wearesellers')),
      getFallbackArticlesForDigest: vi.fn().mockResolvedValue(
        makeScoredArticles(25, 'reddit_seller'),
      ),
    });

    await runPipeline();

    const generatedArticles = mocks.generateEmailHtml.mock.calls[0]?.[0] as Article[];
    expect(generatedArticles.length).toBeGreaterThanOrEqual(30);
    expect(generatedArticles.length).toBeLessThanOrEqual(50);
    expect(mocks.sendDigestEmail).toHaveBeenCalledTimes(1);
  });

  it('attempts repair run when an existing digest is below minimum threshold', async () => {
    const { runPipeline, mocks } = await loadMainWithMocks({
      getDigestByDate: vi.fn().mockResolvedValue({
        date: TODAY,
        sent_at: `${TODAY}T06:00:00.000Z`,
        article_count: 11,
        email_html: '<html>old digest</html>',
      }),
      getRecentRuns: vi.fn().mockResolvedValue([
        {
          run_id: 'old-run-id',
          digest_date: TODAY,
          status: 'sent',
          started_at: `${TODAY}T06:00:00.000Z`,
        },
      ]),
    });

    await runPipeline();

    expect(mocks.markRunFailed).toHaveBeenCalledWith(
      'old-run-id',
      expect.stringContaining('Auto-repair requested'),
    );
    expect(mocks.sendDigestEmail).toHaveBeenCalledTimes(1);
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
