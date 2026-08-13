import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '../store.js';
import type { CoverageGapAlertDecision, MissingSourceGroup } from '../main.js';

interface PipelineMocks {
  collectWeAreSellers: ReturnType<typeof vi.fn>;
  collectRSS: ReturnType<typeof vi.fn>;
  collectReddit: ReturnType<typeof vi.fn>;
  collectSellerCentral: ReturnType<typeof vi.fn>;
  processArticles: ReturnType<typeof vi.fn>;
  rerankFinalSelection: ReturnType<typeof vi.fn>;
  getExistingUrls: ReturnType<typeof vi.fn>;
  upsertArticles: ReturnType<typeof vi.fn>;
  saveDigest: ReturnType<typeof vi.fn>;
  getDigestByDate: ReturnType<typeof vi.fn>;
  acquireRunLock: ReturnType<typeof vi.fn>;
  markRunSent: ReturnType<typeof vi.fn>;
  markRunFailed: ReturnType<typeof vi.fn>;
  markRunSkipped: ReturnType<typeof vi.fn>;
  getRecentRuns: ReturnType<typeof vi.fn>;
  getRecentDigests: ReturnType<typeof vi.fn>;
  getFallbackArticlesForDigest: ReturnType<typeof vi.fn>;
  getActiveSubscribers: ReturnType<typeof vi.fn>;
  saveDigestDeliveries: ReturnType<typeof vi.fn>;
  generateEmailHtml: ReturnType<typeof vi.fn>;
  sendDigestEmail: ReturnType<typeof vi.fn>;
  sendAlertEmail: ReturnType<typeof vi.fn>;
  writeDigestJson: ReturnType<typeof vi.fn>;
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

function makePublishedArticles(
  count: number,
  options: {
    source?: string;
    score?: number;
    startUrl?: string;
    publishedAt: string;
  },
): Article[] {
  const {
    source = 'rss',
    score = 8,
    startUrl = `https://example.com/${source}`,
    publishedAt,
  } = options;
  return Array.from({ length: count }, (_, index) => ({
    source,
    url: `${startUrl}/${index}`,
    canonical_url: `${startUrl}/${index}`,
    title: `Article ${source} ${index}`,
    summary: `摘要 ${index}`,
    category: 'trend',
    score,
    keywords: ['关键词1', '关键词2', '关键词3'],
    published_at: publishedAt,
  }));
}

const BASE_ARTICLE: Article = {
  source: 'rss',
  url: 'https://example.com/post?utm_source=test',
  title: 'Sample title',
};

function makeRawArticle(source: string, suffix: string): Article {
  return {
    source,
    url: `https://example.com/raw/${source}/${suffix}`,
    title: `Raw ${source} ${suffix}`,
  };
}
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1_000)
  .toISOString()
  .slice(0, 10);
const YESTERDAY_ISO = `${YESTERDAY}T08:00:00.000Z`;
const TODAY_ISO = `${TODAY}T08:00:00.000Z`;

function applyRequiredEnv(): void {
  process.env.AMZ_SKIP_MAIN_AUTORUN = '1';
  process.env.DEEPSEEK_API_KEY = 'test-deepseek';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_KEY = 'test-supabase-key';
  process.env.GMAIL_USER = 'sender@example.com';
  process.env.GMAIL_APP_PASSWORD = 'test-password';
  process.env.DIGEST_EMAIL = 'digest@example.com';
  process.env.WEARESELLERS_COOKIES = '[{"name":"x","value":"y","domain":"wearesellers.com"}]';
  process.env.AMZ_REDDIT_RECOVERY_ATTEMPTS = '2';
  process.env.AMZ_REDDIT_RECOVERY_DELAY_MS = '0';
  process.env.AMZ_COLLECTOR_RECOVERY_DELAY_MS = '0';
  process.env.AMZ_WS_RECOVERY_ATTEMPTS = '1';
  process.env.AMZ_RSS_RECOVERY_ATTEMPTS = '1';
  process.env.AMZ_SC_RECOVERY_ATTEMPTS = '1';
  process.env.AMZ_SECONDARY_COVERAGE_ALERT_STREAK = '2';
}

async function loadMainWithMocks(
  overrides: Partial<PipelineMocks> = {},
): Promise<{
  runPipeline: () => Promise<void>;
  runPipelineWithTimeout: (timeoutMs?: number) => Promise<void>;
  decideCoverageGapAlert: (
    date: string,
    missingGroups: MissingSourceGroup[],
  ) => Promise<CoverageGapAlertDecision>;
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
    rerankFinalSelection: vi.fn(async (articles: Article[]) => articles),
    getExistingUrls: vi.fn().mockResolvedValue(new Set<string>()),
    upsertArticles: vi.fn().mockResolvedValue(1),
    saveDigest: vi.fn().mockResolvedValue(undefined),
    getDigestByDate: vi.fn().mockResolvedValue(null),
    acquireRunLock: vi.fn().mockResolvedValue(true),
    markRunSent: vi.fn().mockResolvedValue(undefined),
    markRunFailed: vi.fn().mockResolvedValue(undefined),
    markRunSkipped: vi.fn().mockResolvedValue(undefined),
    getRecentRuns: vi.fn().mockResolvedValue([]),
    getRecentDigests: vi.fn().mockResolvedValue([]),
    getFallbackArticlesForDigest: vi.fn().mockResolvedValue([]),
    getActiveSubscribers: vi.fn().mockResolvedValue([]),
    saveDigestDeliveries: vi.fn().mockResolvedValue(undefined),
    generateEmailHtml: vi.fn().mockReturnValue('<html>digest</html>'),
    sendDigestEmail: vi.fn().mockResolvedValue({
      sent: [{ email: 'digest@example.com', messageId: 'msg-id' }],
      failed: [],
    }),
    sendAlertEmail: vi.fn().mockResolvedValue(undefined),
    writeDigestJson: vi.fn().mockResolvedValue({ articles: [], article_count: 0 }),
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
    rerankFinalSelection: mocks.rerankFinalSelection,
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
    getRecentDigests: mocks.getRecentDigests,
    getFallbackArticlesForDigest: mocks.getFallbackArticlesForDigest,
    getActiveSubscribers: mocks.getActiveSubscribers,
    saveDigestDeliveries: mocks.saveDigestDeliveries,
  }));
  vi.doMock('../email.js', () => ({
    generateEmailHtml: mocks.generateEmailHtml,
    sendDigestEmail: mocks.sendDigestEmail,
    sendAlertEmail: mocks.sendAlertEmail,
  }));
  vi.doMock('../publish.js', () => ({
    writeDigestJson: mocks.writeDigestJson,
  }));

  const mod = await import('../main.js');
  return {
    runPipeline: mod.runPipeline as () => Promise<void>,
    runPipelineWithTimeout: mod.runPipelineWithTimeout as (timeoutMs?: number) => Promise<void>,
    decideCoverageGapAlert: mod.decideCoverageGapAlert as (
      date: string,
      missingGroups: MissingSourceGroup[],
    ) => Promise<CoverageGapAlertDecision>,
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

  it('skips the send but still persists and publishes when AMZ_DIGEST_EMAIL_ENABLED=0', async () => {
    // email leg retired per Director ruling 2026-07-29: the switch must disable
    // delivery only - HTML generation, Supabase persistence and the
    // digest-latest.json publish (amz-autopilot's news source) all stay live.
    process.env.AMZ_DIGEST_EMAIL_ENABLED = '0';
    try {
      const { runPipeline, mocks } = await loadMainWithMocks();

      await runPipeline();

      expect(mocks.sendDigestEmail).not.toHaveBeenCalled();
      expect(mocks.getActiveSubscribers).not.toHaveBeenCalled();
      expect(mocks.generateEmailHtml).toHaveBeenCalledTimes(1);
      expect(mocks.saveDigest).toHaveBeenCalledWith(
        expect.objectContaining({ run_id: 'run-test-id', status: 'sent' }),
      );
      expect(mocks.writeDigestJson).toHaveBeenCalledTimes(1);
      expect(mocks.markRunSent).toHaveBeenCalledWith('run-test-id', 30);
      expect(mocks.markRunFailed).not.toHaveBeenCalled();
    } finally {
      delete process.env.AMZ_DIGEST_EMAIL_ENABLED;
    }
  });

  it('preserves at least one item per active source group when fallback can provide them', async () => {
    const strictOnlyAmz = makePublishedArticles(35, {
      source: 'amz123',
      score: 8,
      startUrl: 'https://example.com/strict-amz',
      publishedAt: TODAY_ISO,
    });
    const sourceRecoveryFallback = [
      makePublishedArticles(1, {
        source: 'wearesellers',
        score: 7,
        startUrl: 'https://example.com/recover-wearesellers',
        publishedAt: TODAY_ISO,
      })[0],
      makePublishedArticles(1, {
        source: 'reddit_fba',
        score: 7,
        startUrl: 'https://example.com/recover-reddit',
        publishedAt: TODAY_ISO,
      })[0],
      makePublishedArticles(1, {
        source: 'sellercentral',
        score: 7,
        startUrl: 'https://example.com/recover-sellercentral',
        publishedAt: TODAY_ISO,
      })[0],
    ];

    const { runPipeline, mocks } = await loadMainWithMocks({
      collectWeAreSellers: vi.fn().mockResolvedValue([makeRawArticle('wearesellers', '1')]),
      collectRSS: vi.fn().mockResolvedValue([makeRawArticle('amz123', '1')]),
      collectReddit: vi.fn().mockResolvedValue([makeRawArticle('reddit_fba', '1')]),
      collectSellerCentral: vi.fn().mockResolvedValue([makeRawArticle('sellercentral', '1')]),
      processArticles: vi.fn().mockResolvedValue(strictOnlyAmz),
      getFallbackArticlesForDigest: vi.fn().mockResolvedValue(sourceRecoveryFallback),
    });

    await runPipeline();

    const generatedArticles = (mocks.generateEmailHtml.mock.calls[0]?.[0] as Article[]) ?? [];
    const sources = new Set(generatedArticles.map((item) => item.source));
    expect(sources.has('wearesellers')).toBe(true);
    expect(sources.has('amz123')).toBe(true);
    expect(sources.has('sellercentral')).toBe(true);
    expect(
      generatedArticles.some(
        (item) => item.source === 'reddit_fba' || item.source === 'reddit_seller',
      ),
    ).toBe(true);
  });

  it('sends source-gap alert tag when key sources are missing but pipeline continues', async () => {
    const { runPipeline, mocks } = await loadMainWithMocks({
      collectWeAreSellers: vi.fn().mockResolvedValue(makeScoredArticles(6, 'wearesellers')),
      collectRSS: vi.fn().mockResolvedValue(makeScoredArticles(5, 'amz123')),
      collectReddit: vi.fn().mockResolvedValue([]),
      collectSellerCentral: vi.fn().mockResolvedValue([]),
    });

    await runPipeline();

    expect(mocks.sendAlertEmail).toHaveBeenCalledWith(
      expect.stringContaining('[SOURCE_GAP]'),
    );
    expect(mocks.sendDigestEmail).toHaveBeenCalledTimes(1);
  });

  it('retries wearesellers collector when initial result is empty and recovers', async () => {
    const recoverableWearesellers = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(makeScoredArticles(6, 'wearesellers'));

    const { runPipeline } = await loadMainWithMocks({
      collectWeAreSellers: recoverableWearesellers,
      collectRSS: vi.fn().mockResolvedValue(makeScoredArticles(5, 'amz123')),
      collectReddit: vi.fn().mockResolvedValue(makeScoredArticles(5, 'reddit_fba')),
      collectSellerCentral: vi.fn().mockResolvedValue(makeScoredArticles(3, 'sellercentral')),
    });

    await runPipeline();

    expect(recoverableWearesellers).toHaveBeenCalledTimes(2);
  });

  it('suppresses first-day sellercentral-only coverage gap alert', async () => {
    const onlySellerCentralMissing = [
      ...makeScoredArticles(14, 'wearesellers'),
      ...makeScoredArticles(14, 'reddit_fba'),
      ...makeScoredArticles(2, 'amz123'),
    ];

    const { runPipeline, mocks } = await loadMainWithMocks({
      collectWeAreSellers: vi.fn().mockResolvedValue(makeScoredArticles(6, 'wearesellers')),
      collectRSS: vi.fn().mockResolvedValue(makeScoredArticles(5, 'amz123')),
      collectReddit: vi.fn().mockResolvedValue(makeScoredArticles(5, 'reddit_fba')),
      collectSellerCentral: vi.fn().mockResolvedValue(makeScoredArticles(1, 'sellercentral')),
      processArticles: vi.fn().mockResolvedValue(onlySellerCentralMissing),
      getRecentDigests: vi.fn().mockResolvedValue([
        {
          date: YESTERDAY,
          email_html: '<p>来源: sellercentral</p>',
        },
      ]),
    });

    await runPipeline();

    expect(mocks.sendAlertEmail).not.toHaveBeenCalledWith(
      expect.stringContaining('[SOURCE_COVERAGE_GAP]'),
    );
  });

  it('alerts sellercentral coverage gap when missing streak reaches threshold', async () => {
    const onlySellerCentralMissing = [
      ...makeScoredArticles(14, 'wearesellers'),
      ...makeScoredArticles(14, 'reddit_fba'),
      ...makeScoredArticles(2, 'amz123'),
    ];

    const { runPipeline, mocks } = await loadMainWithMocks({
      collectWeAreSellers: vi.fn().mockResolvedValue(makeScoredArticles(6, 'wearesellers')),
      collectRSS: vi.fn().mockResolvedValue(makeScoredArticles(5, 'amz123')),
      collectReddit: vi.fn().mockResolvedValue(makeScoredArticles(5, 'reddit_fba')),
      collectSellerCentral: vi.fn().mockResolvedValue(makeScoredArticles(1, 'sellercentral')),
      processArticles: vi.fn().mockResolvedValue(onlySellerCentralMissing),
      getRecentDigests: vi.fn().mockResolvedValue([
        {
          date: YESTERDAY,
          email_html: '<p>来源: wearesellers</p>',
        },
      ]),
    });

    await runPipeline();

    expect(mocks.sendAlertEmail).toHaveBeenCalledWith(
      expect.stringContaining('[SOURCE_COVERAGE_GAP]'),
    );
  });

  it('does not claim a quota slot for a source whose raw articles are all DB duplicates', async () => {
    const onlySellerCentralMissing = [
      ...makeScoredArticles(14, 'wearesellers'),
      ...makeScoredArticles(14, 'reddit_fba'),
      ...makeScoredArticles(2, 'amz123'),
    ];

    const { runPipeline, mocks } = await loadMainWithMocks({
      collectWeAreSellers: vi.fn().mockResolvedValue(makeScoredArticles(6, 'wearesellers')),
      collectRSS: vi.fn().mockResolvedValue(makeScoredArticles(5, 'amz123')),
      collectReddit: vi.fn().mockResolvedValue(makeScoredArticles(5, 'reddit_fba')),
      collectSellerCentral: vi.fn().mockResolvedValue([makeRawArticle('sellercentral', '1')]),
      // Every collected SellerCentral URL is already stored, so the group brings no
      // new article today and must not be asked to fill a digest slot.
      getExistingUrls: vi.fn(async (urls: string[]) =>
        new Set(urls.filter((url) => url.includes('/sellercentral/'))),
      ),
      processArticles: vi.fn().mockResolvedValue(onlySellerCentralMissing),
      getRecentDigests: vi.fn().mockResolvedValue([
        {
          date: YESTERDAY,
          email_html: '<p>来源: wearesellers</p>',
        },
      ]),
    });

    await runPipeline();

    expect(mocks.sendAlertEmail).not.toHaveBeenCalledWith(
      expect.stringContaining('[SOURCE_COVERAGE_GAP]'),
    );
    expect(mocks.sendDigestEmail).toHaveBeenCalledTimes(1);
  });

  it('retries reddit collection and recovers before continuing pipeline', async () => {
    const recoverableReddit = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeRawArticle('reddit_fba', 'recovered')]);

    const { runPipeline, mocks } = await loadMainWithMocks({
      collectReddit: recoverableReddit,
      collectWeAreSellers: vi.fn().mockResolvedValue(makeScoredArticles(6, 'wearesellers')),
      collectRSS: vi.fn().mockResolvedValue(makeScoredArticles(5, 'amz123')),
      collectSellerCentral: vi.fn().mockResolvedValue(makeScoredArticles(3, 'sellercentral')),
    });

    await runPipeline();

    expect(recoverableReddit).toHaveBeenCalledTimes(2);
    const sentHtml = mocks.sendDigestEmail.mock.calls[0]?.[0] as string;
    expect(sentHtml).not.toContain('今日 Reddit 采集失败');
  });

  it('continues sending with explicit warning when reddit recovery still fails', async () => {
    const failedReddit = vi.fn().mockResolvedValue([]);
    const { runPipeline, mocks } = await loadMainWithMocks({
      collectReddit: failedReddit,
      collectWeAreSellers: vi.fn().mockResolvedValue(makeScoredArticles(6, 'wearesellers')),
      collectRSS: vi.fn().mockResolvedValue(makeScoredArticles(5, 'amz123')),
      collectSellerCentral: vi.fn().mockResolvedValue(makeScoredArticles(3, 'sellercentral')),
    });

    await runPipeline();

    expect(failedReddit).toHaveBeenCalledTimes(3);
    expect(mocks.sendAlertEmail).toHaveBeenCalledWith(
      expect.stringContaining('[REDDIT_RECOVERY_FAILED]'),
    );
    const sentHtml = mocks.sendDigestEmail.mock.calls[0]?.[0] as string;
    expect(sentHtml).toContain('今日 Reddit 采集失败');
  });

  it('renders the digest from the reranked final selection', async () => {
    const reranked = makeScoredArticles(30, 'reranked');

    const { runPipeline, mocks } = await loadMainWithMocks({
      rerankFinalSelection: vi.fn().mockResolvedValue(reranked),
    });

    await runPipeline();

    expect(mocks.rerankFinalSelection).toHaveBeenCalledTimes(1);
    const rerankInput = mocks.rerankFinalSelection.mock.calls[0]?.[0] as Article[];
    expect(rerankInput.length).toBe(30);
    expect(mocks.generateEmailHtml.mock.calls[0]?.[0]).toBe(reranked);
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

  it('sends degraded digest when strict-quality pool is below minimum and relaxed top-up is poor', async () => {
    const { runPipeline, mocks } = await loadMainWithMocks({
      processArticles: vi.fn().mockResolvedValue(makeScoredArticles(8, 'rss')),
      getFallbackArticlesForDigest: vi.fn().mockResolvedValue(
        makeScoredArticles(10, 'reddit_fba'),
      ),
    });

    await runPipeline();

    const generatedArticles = (mocks.generateEmailHtml.mock.calls[0]?.[0] as Article[]) ?? [];
    expect(generatedArticles.length).toBe(18);
    expect(generatedArticles.every((item) => (item.score ?? 0) >= 6)).toBe(true);
    expect(mocks.sendAlertEmail).toHaveBeenCalledWith(
      expect.stringContaining('[LOW_VOLUME_MODE]'),
    );
    expect(mocks.sendDigestEmail).toHaveBeenCalledTimes(1);
    expect(mocks.markRunFailed).not.toHaveBeenCalled();
  });

  it('fails before sending when strict-quality pool is too small for degraded mode', async () => {
    const { runPipeline, mocks } = await loadMainWithMocks({
      processArticles: vi.fn().mockResolvedValue(makeScoredArticles(3, 'rss')),
      getFallbackArticlesForDigest: vi.fn().mockResolvedValue(
        makeScoredArticles(2, 'reddit_fba'),
      ),
    });

    await expect(runPipeline()).rejects.toThrow('below minimum');

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

  it('excludes recently delivered URLs when filling from fallback pool', async () => {
    const fresh = makeScoredArticles(10, 'wearesellers');
    const repeatedLinks = Array.from(
      { length: 20 },
      (_, index) => `https://example.com/repeat/${index}`,
    );
    const fallback = [
      ...repeatedLinks.map((url, index) => ({
        ...makeScoredArticles(1, 'amz123')[0],
        url,
        canonical_url: url,
        source: 'amz123',
        title: `Repeated ${index}`,
      })),
      ...Array.from({ length: 20 }, (_, index) => {
        const url = `https://example.com/newpool/${index}`;
        return {
          ...makeScoredArticles(1, 'reddit_fba')[0],
          url,
          canonical_url: url,
          source: 'reddit_fba',
          title: `Fresh fallback ${index}`,
        };
      }),
    ];
    const recentDigestHtml = repeatedLinks
      .map(
        (url) =>
          `<a href="${url}" style="font-size:15px;font-weight:600;color:#1a365d;text-decoration:none;line-height:1.5;" target="_blank">old</a>`,
      )
      .join('\n');

    const { runPipeline, mocks } = await loadMainWithMocks({
      processArticles: vi.fn().mockResolvedValue(fresh),
      getRecentDigests: vi.fn().mockResolvedValue([
        {
          date: YESTERDAY,
          email_html: recentDigestHtml,
        },
      ]),
      getFallbackArticlesForDigest: vi.fn().mockResolvedValue(fallback),
    });

    await runPipeline();

    const generatedArticles = (mocks.generateEmailHtml.mock.calls[0]?.[0] as Article[]) ?? [];
    const generatedUrls = new Set(generatedArticles.map((item) => item.url));
    expect(generatedArticles.length).toBe(30);
    expect(mocks.getRecentDigests).toHaveBeenCalledTimes(1);
    for (const repeatedUrl of repeatedLinks) {
      expect(generatedUrls.has(repeatedUrl)).toBe(false);
    }
  });

  it('prioritizes same-day fresh content over stale fallback when filling window', async () => {
    const strictSelected = makePublishedArticles(10, {
      source: 'wearesellers',
      score: 8,
      startUrl: 'https://example.com/strict',
      publishedAt: YESTERDAY_ISO,
    });
    const staleFallback = makePublishedArticles(30, {
      source: 'amz123',
      score: 9,
      startUrl: 'https://example.com/stale-fallback',
      publishedAt: YESTERDAY_ISO,
    });
    const freshFallback = makePublishedArticles(25, {
      source: 'reddit_fba',
      score: 6,
      startUrl: 'https://example.com/fresh-fallback',
      publishedAt: TODAY_ISO,
    });

    const { runPipeline, mocks } = await loadMainWithMocks({
      processArticles: vi.fn().mockResolvedValue(strictSelected),
      getFallbackArticlesForDigest: vi
        .fn()
        .mockResolvedValueOnce([...staleFallback, ...freshFallback])
        .mockResolvedValueOnce([...staleFallback, ...freshFallback]),
    });

    await runPipeline();

    const generatedArticles = (mocks.generateEmailHtml.mock.calls[0]?.[0] as Article[]) ?? [];
    const freshCount = generatedArticles.filter(
      (item) => item.published_at?.slice(0, 10) === TODAY,
    ).length;
    expect(generatedArticles.length).toBeGreaterThanOrEqual(30);
    expect(freshCount).toBeGreaterThanOrEqual(20);
  });

  it('avoids relaxed low-score items when strict-quality pool can satisfy minimum', async () => {
    const strictSelected = makePublishedArticles(10, {
      source: 'wearesellers',
      score: 7,
      startUrl: 'https://example.com/strict-only',
      publishedAt: TODAY_ISO,
    });
    const strictFallback = makePublishedArticles(30, {
      source: 'reddit_seller',
      score: 6,
      startUrl: 'https://example.com/strict-fallback',
      publishedAt: YESTERDAY_ISO,
    });
    const lowScoreFallback = makePublishedArticles(20, {
      source: 'amz123',
      score: 4,
      startUrl: 'https://example.com/low-score',
      publishedAt: YESTERDAY_ISO,
    });

    const { runPipeline, mocks } = await loadMainWithMocks({
      processArticles: vi.fn().mockResolvedValue(strictSelected),
      getFallbackArticlesForDigest: vi
        .fn()
        .mockResolvedValueOnce(strictFallback)
        .mockResolvedValueOnce(lowScoreFallback),
    });

    await runPipeline();

    const generatedArticles = (mocks.generateEmailHtml.mock.calls[0]?.[0] as Article[]) ?? [];
    const minScore = Math.min(...generatedArticles.map((item) => item.score ?? 0));
    expect(generatedArticles.length).toBeGreaterThanOrEqual(30);
    expect(minScore).toBeGreaterThanOrEqual(6);
  });

  it('does not include relaxed initial articles when strict pool already reaches minimum after strict fallback', async () => {
    const strictSelected = makePublishedArticles(20, {
      source: 'wearesellers',
      score: 6,
      startUrl: 'https://example.com/strict-selected',
      publishedAt: YESTERDAY_ISO,
    });
    const relaxedInitial = makePublishedArticles(20, {
      source: 'amz123',
      score: 5,
      startUrl: 'https://example.com/relaxed-initial',
      publishedAt: TODAY_ISO,
    });
    const strictFallback = makePublishedArticles(10, {
      source: 'reddit_seller',
      score: 6,
      startUrl: 'https://example.com/strict-fallback-min',
      publishedAt: YESTERDAY_ISO,
    });

    const { runPipeline, mocks } = await loadMainWithMocks({
      processArticles: vi.fn().mockResolvedValue([...strictSelected, ...relaxedInitial]),
      getFallbackArticlesForDigest: vi.fn().mockResolvedValue(strictFallback),
    });

    await runPipeline();

    const generatedArticles = (mocks.generateEmailHtml.mock.calls[0]?.[0] as Article[]) ?? [];
    expect(generatedArticles.length).toBeGreaterThanOrEqual(30);
    expect(generatedArticles.every((item) => (item.score ?? 0) >= 6)).toBe(true);
  });

  it('boosts reddit items when wearesellers is weak and strict pool is below minimum', async () => {
    const weakWearesellers = makePublishedArticles(2, {
      source: 'wearesellers',
      score: 6,
      startUrl: 'https://example.com/ws-weak',
      publishedAt: YESTERDAY_ISO,
    });
    const strictBase = makePublishedArticles(12, {
      source: 'amz123',
      score: 6,
      startUrl: 'https://example.com/base',
      publishedAt: YESTERDAY_ISO,
    });
    const amzFallback = makePublishedArticles(40, {
      source: 'amz123',
      score: 6,
      startUrl: 'https://example.com/fallback-amz',
      publishedAt: YESTERDAY_ISO,
    });
    const redditFallback = makePublishedArticles(10, {
      source: 'reddit_fba',
      score: 6,
      startUrl: 'https://example.com/fallback-reddit',
      publishedAt: YESTERDAY_ISO,
    });

    const { runPipeline, mocks } = await loadMainWithMocks({
      collectWeAreSellers: vi.fn().mockResolvedValue(weakWearesellers),
      processArticles: vi.fn().mockResolvedValue(strictBase),
      getFallbackArticlesForDigest: vi.fn().mockResolvedValue([
        ...amzFallback,
        ...redditFallback,
      ]),
    });

    await runPipeline();

    const generatedArticles = (mocks.generateEmailHtml.mock.calls[0]?.[0] as Article[]) ?? [];
    const redditCount = generatedArticles.filter((item) =>
      item.source === 'reddit_fba' || item.source === 'reddit_seller',
    ).length;
    expect(generatedArticles.length).toBeGreaterThanOrEqual(30);
    expect(redditCount).toBeGreaterThanOrEqual(8);
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

describe('decideCoverageGapAlert cadence', () => {
  const MONDAY_UTC = '2026-08-10';
  const WEDNESDAY_UTC = '2026-08-12';

  function missingSellerCentralGroup(): MissingSourceGroup {
    return {
      target: { key: 'sellercentral', label: 'SellerCentral', sources: ['sellercentral'], min: 1 },
      count: 0,
      missing: 1,
    };
  }

  function digestsWithoutSellerCentral(dates: string[]) {
    return dates.map((date) => ({ date, email_html: '<p>来源: wearesellers</p>' }));
  }

  it('fires on the first day the missing streak reaches the threshold, on any weekday', async () => {
    const { decideCoverageGapAlert } = await loadMainWithMocks({
      getRecentDigests: vi.fn().mockResolvedValue(digestsWithoutSellerCentral(['2026-08-11'])),
    });

    const decision = await decideCoverageGapAlert(WEDNESDAY_UTC, [missingSellerCentralGroup()]);

    expect(decision.shouldAlert).toBe(true);
    expect(decision.streakTags).toEqual(['SellerCentral=2/2']);
  });

  it('suppresses repeat alerts past the threshold on non-reminder days', async () => {
    const { decideCoverageGapAlert } = await loadMainWithMocks({
      getRecentDigests: vi.fn().mockResolvedValue(
        digestsWithoutSellerCentral([
          '2026-08-11',
          '2026-08-10',
          '2026-08-09',
          '2026-08-08',
          '2026-08-07',
        ]),
      ),
    });

    const decision = await decideCoverageGapAlert(WEDNESDAY_UTC, [missingSellerCentralGroup()]);

    expect(decision.shouldAlert).toBe(false);
    expect(decision.suppressedTags).toEqual(['SellerCentral=6/2']);
  });

  it('re-alerts on the weekly reminder day (Monday UTC) while the gap persists', async () => {
    const { decideCoverageGapAlert } = await loadMainWithMocks({
      getRecentDigests: vi.fn().mockResolvedValue(
        digestsWithoutSellerCentral([
          '2026-08-09',
          '2026-08-08',
          '2026-08-07',
          '2026-08-06',
          '2026-08-05',
        ]),
      ),
    });

    const decision = await decideCoverageGapAlert(MONDAY_UTC, [missingSellerCentralGroup()]);

    expect(decision.shouldAlert).toBe(true);
  });

  it('always fires when a primary source group is missing', async () => {
    const { decideCoverageGapAlert } = await loadMainWithMocks();

    const decision = await decideCoverageGapAlert(WEDNESDAY_UTC, [
      {
        target: { key: 'wearesellers', label: '知无不言', sources: ['wearesellers'], min: 1 },
        count: 0,
        missing: 1,
      },
    ]);

    expect(decision.shouldAlert).toBe(true);
  });
});
