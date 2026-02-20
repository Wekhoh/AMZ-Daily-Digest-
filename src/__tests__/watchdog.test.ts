import { beforeEach, describe, expect, it, vi } from 'vitest';

interface WatchdogMocks {
  getDigestByDate: ReturnType<typeof vi.fn>;
  sendAlertEmail: ReturnType<typeof vi.fn>;
}

async function loadWatchdogWithMocks(
  overrides: Partial<WatchdogMocks> = {},
): Promise<{
  runWatchdog: (now?: Date) => Promise<void>;
  resolveWatchdogDate: (now?: Date, override?: string) => string;
  mocks: WatchdogMocks;
}> {
  vi.resetModules();

  process.env.AMZ_SKIP_WATCHDOG_AUTORUN = '1';
  delete process.env.AMZ_WATCHDOG_DATE;
  delete process.env.AMZ_WATCHDOG_ALERT_ON_MISSING;

  const mocks: WatchdogMocks = {
    getDigestByDate: vi.fn().mockResolvedValue({
      date: '2026-02-19',
      article_count: 30,
    }),
    sendAlertEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  vi.doMock('../store.js', () => ({
    getDigestByDate: mocks.getDigestByDate,
  }));
  vi.doMock('../email.js', () => ({
    sendAlertEmail: mocks.sendAlertEmail,
  }));

  const mod = await import('../watchdog.js');
  return {
    runWatchdog: mod.runWatchdog as (now?: Date) => Promise<void>,
    resolveWatchdogDate: mod.resolveWatchdogDate as (now?: Date, override?: string) => string,
    mocks,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('watchdog', () => {
  it('resolveWatchdogDate uses UTC today by default', async () => {
    const { resolveWatchdogDate } = await loadWatchdogWithMocks();
    const date = resolveWatchdogDate(new Date('2026-02-19T06:35:00.000Z'));
    expect(date).toBe('2026-02-19');
  });

  it('resolveWatchdogDate accepts explicit override', async () => {
    const { resolveWatchdogDate } = await loadWatchdogWithMocks();
    const date = resolveWatchdogDate(
      new Date('2026-02-19T06:35:00.000Z'),
      '2026-03-01',
    );
    expect(date).toBe('2026-03-01');
  });

  it('runWatchdog passes when digest exists', async () => {
    const { runWatchdog, mocks } = await loadWatchdogWithMocks({
      getDigestByDate: vi.fn().mockResolvedValue({
        date: '2026-02-19',
        article_count: 35,
      }),
    });

    await expect(runWatchdog(new Date('2026-02-19T06:35:00.000Z'))).resolves.toBeUndefined();
    expect(mocks.sendAlertEmail).not.toHaveBeenCalled();
  });

  it('runWatchdog alerts and fails when digest exists but article_count is below minimum', async () => {
    const { runWatchdog, mocks } = await loadWatchdogWithMocks({
      getDigestByDate: vi.fn().mockResolvedValue({
        date: '2026-02-19',
        article_count: 11,
      }),
    });

    await expect(
      runWatchdog(new Date('2026-02-19T06:35:00.000Z')),
    ).rejects.toThrow('below minimum');
    expect(mocks.sendAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('runWatchdog alerts and fails when digest is missing', async () => {
    const { runWatchdog, mocks } = await loadWatchdogWithMocks({
      getDigestByDate: vi.fn().mockResolvedValue(null),
    });

    await expect(
      runWatchdog(new Date('2026-02-19T06:35:00.000Z')),
    ).rejects.toThrow('Digest missing for 2026-02-19');
    expect(mocks.sendAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('runWatchdog can skip alerts via env toggle', async () => {
    const { runWatchdog, mocks } = await loadWatchdogWithMocks({
      getDigestByDate: vi.fn().mockResolvedValue(null),
    });
    process.env.AMZ_WATCHDOG_ALERT_ON_MISSING = '0';

    await expect(
      runWatchdog(new Date('2026-02-19T06:35:00.000Z')),
    ).rejects.toThrow('Digest missing for 2026-02-19');
    expect(mocks.sendAlertEmail).not.toHaveBeenCalled();
  });
});
