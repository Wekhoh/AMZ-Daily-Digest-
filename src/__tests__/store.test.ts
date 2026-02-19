import { describe, it, expect, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}));

async function loadStoreWithDb(db: unknown) {
  vi.resetModules();
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_KEY = 'test-key';

  const supabase = await import('@supabase/supabase-js');
  const createClientMock = vi.mocked(supabase.createClient);
  createClientMock.mockReset();
  createClientMock.mockReturnValue(db as never);

  const store = await import('../store.js');
  return { store, createClientMock };
}

describe('store canonical URL flows', () => {
  it('getExistingUrls uses canonical_url lookup when schema exists', async () => {
    const inCanonical = vi.fn().mockResolvedValue({
      data: [{ canonical_url: 'https://example.com/a' }],
      error: null,
    });
    const inLegacy = vi.fn();

    const db = {
      from: vi.fn(() => ({
        select: vi.fn((column: string) => {
          if (column === 'canonical_url') return { in: inCanonical };
          if (column === 'url') return { in: inLegacy };
          throw new Error(`Unexpected select column: ${column}`);
        }),
      })),
    };

    const { store, createClientMock } = await loadStoreWithDb(db);
    const result = await store.getExistingUrls([
      'https://example.com/a',
      'https://example.com/b',
    ]);

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(inCanonical).toHaveBeenCalledWith('canonical_url', [
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(result).toEqual(new Set(['https://example.com/a']));
    expect(inLegacy).not.toHaveBeenCalled();
  });

  it('getExistingUrls falls back to url when canonical_url column is missing', async () => {
    const inCanonical = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '42703', message: 'column canonical_url does not exist' },
    });
    const inLegacy = vi.fn().mockResolvedValue({
      data: [{ url: 'https://legacy.com/post' }],
      error: null,
    });

    const db = {
      from: vi.fn(() => ({
        select: vi.fn((column: string) => {
          if (column === 'canonical_url') return { in: inCanonical };
          if (column === 'url') return { in: inLegacy };
          throw new Error(`Unexpected select column: ${column}`);
        }),
      })),
    };

    const { store } = await loadStoreWithDb(db);
    const result = await store.getExistingUrls(['https://legacy.com/post']);

    expect(inCanonical).toHaveBeenCalledWith('canonical_url', ['https://legacy.com/post']);
    expect(inLegacy).toHaveBeenCalledWith('url', ['https://legacy.com/post']);
    expect(result).toEqual(new Set(['https://legacy.com/post']));
  });

  it('upsertArticles writes on canonical_url and auto-fills raw_url/canonical_url', async () => {
    const selectModern = vi.fn().mockResolvedValue({
      data: [{ id: '1' }],
      error: null,
    });
    const upsert = vi.fn().mockReturnValue({
      select: selectModern,
    });
    const db = {
      from: vi.fn(() => ({
        upsert,
      })),
    };

    const { store } = await loadStoreWithDb(db);
    const count = await store.upsertArticles([
      {
        source: 'rss',
        url: 'https://example.com/post?a=1',
        title: 'Example post',
      },
    ]);

    expect(count).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          url: 'https://example.com/post?a=1',
          raw_url: 'https://example.com/post?a=1',
          canonical_url: 'https://example.com/post?a=1',
        }),
      ],
      { onConflict: 'canonical_url', ignoreDuplicates: true },
    );
  });

  it('upsertArticles falls back to legacy url conflict when canonical_url is unavailable', async () => {
    const selectModern = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '42703', message: 'column canonical_url does not exist' },
    });
    const selectLegacy = vi.fn().mockResolvedValue({
      data: [{ id: '1' }],
      error: null,
    });
    const upsert = vi
      .fn()
      .mockReturnValueOnce({ select: selectModern })
      .mockReturnValueOnce({ select: selectLegacy });
    const db = {
      from: vi.fn(() => ({
        upsert,
      })),
    };

    const { store } = await loadStoreWithDb(db);
    const count = await store.upsertArticles([
      {
        source: 'reddit_fba',
        url: 'https://reddit.com/r/test',
        title: 'Legacy path',
      },
    ]);

    expect(count).toBe(1);
    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      { onConflict: 'canonical_url', ignoreDuplicates: true },
    );
    expect(upsert).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      { onConflict: 'url', ignoreDuplicates: true },
    );

    const legacyRows = upsert.mock.calls[1][0] as Array<Record<string, unknown>>;
    expect(legacyRows[0]).not.toHaveProperty('raw_url');
    expect(legacyRows[0]).not.toHaveProperty('canonical_url');
  });

  it('upsertArticles falls back when PostgREST schema cache misses canonical_url (PGRST204)', async () => {
    const selectModern = vi.fn().mockResolvedValue({
      data: null,
      error: { code: 'PGRST204', message: "Could not find the 'canonical_url' column of 'articles' in the schema cache" },
    });
    const selectLegacy = vi.fn().mockResolvedValue({
      data: [{ id: '1' }],
      error: null,
    });
    const upsert = vi
      .fn()
      .mockReturnValueOnce({ select: selectModern })
      .mockReturnValueOnce({ select: selectLegacy });
    const db = {
      from: vi.fn(() => ({
        upsert,
      })),
    };

    const { store } = await loadStoreWithDb(db);
    const count = await store.upsertArticles([
      {
        source: 'reddit_seller',
        url: 'https://reddit.com/r/postgrest',
        title: 'PostgREST cache fallback',
      },
    ]);

    expect(count).toBe(1);
    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      { onConflict: 'canonical_url', ignoreDuplicates: true },
    );
    expect(upsert).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      { onConflict: 'url', ignoreDuplicates: true },
    );
  });
});

describe('store acquireRunLock stale recovery', () => {
  it('gracefully bypasses run lock when digest_runs table is missing (PGRST205)', async () => {
    const insert = vi.fn().mockResolvedValue({
      error: {
        code: 'PGRST205',
        message: "Could not find the table 'public.digest_runs' in the schema cache",
      },
    });
    const db = {
      from: vi.fn(() => ({
        insert,
      })),
    };

    const { store } = await loadStoreWithDb(db);
    const acquired = await store.acquireRunLock('2026-02-18', 'new-run');

    expect(acquired).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('returns false when an existing lock is already sent', async () => {
    const insert = vi.fn().mockResolvedValue({
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        run_id: 'existing-run',
        status: 'sent',
        started_at: new Date('2026-02-18T00:00:00.000Z').toISOString(),
      },
      error: null,
    });
    const limit = vi.fn(() => ({ maybeSingle }));
    const order = vi.fn(() => ({ limit }));
    const inFilter = vi.fn(() => ({ order }));
    const eqDigestDate = vi.fn(() => ({ in: inFilter }));
    const select = vi.fn(() => ({ eq: eqDigestDate }));
    const update = vi.fn();

    const db = {
      from: vi.fn(() => ({ insert, select, update })),
    };

    const { store } = await loadStoreWithDb(db);
    const acquired = await store.acquireRunLock('2026-02-18', 'new-run');

    expect(acquired).toBe(false);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('releases stale running lock then acquires a new one', async () => {
    const staleStartedAt = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
    const insert = vi
      .fn()
      .mockResolvedValueOnce({
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      })
      .mockResolvedValueOnce({ error: null });
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        run_id: 'stale-run-id',
        status: 'running',
        started_at: staleStartedAt,
      },
      error: null,
    });
    const limit = vi.fn(() => ({ maybeSingle }));
    const order = vi.fn(() => ({ limit }));
    const inFilter = vi.fn(() => ({ order }));
    const eqDigestDate = vi.fn(() => ({ in: inFilter }));
    const select = vi.fn(() => ({ eq: eqDigestDate }));
    const eqStatus = vi.fn().mockResolvedValue({ error: null });
    const eqRunId = vi.fn(() => ({ eq: eqStatus }));
    const update = vi.fn(() => ({ eq: eqRunId }));

    const db = {
      from: vi.fn(() => ({ insert, select, update })),
    };

    const { store } = await loadStoreWithDb(db);
    const acquired = await store.acquireRunLock('2026-02-18', 'new-run');

    expect(acquired).toBe(true);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
      }),
    );
    expect(eqRunId).toHaveBeenCalledWith('run_id', 'stale-run-id');
    expect(eqStatus).toHaveBeenCalledWith('status', 'running');
  });
});

describe('store backward compatibility for legacy digests schema', () => {
  it.each([
    ['42703', 'column digests.run_id does not exist'],
    ['PGRST204', "Could not find the 'run_id' column of 'digests' in the schema cache"],
  ])('saveDigest falls back when run_id/status columns are missing (%s)', async (code, message) => {
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({
        error: { code, message },
      })
      .mockResolvedValueOnce({ error: null });

    const db = {
      from: vi.fn(() => ({ upsert })),
    };

    const { store } = await loadStoreWithDb(db);
    await store.saveDigest({
      date: '2026-02-18',
      sent_at: '2026-02-18T06:00:00.000Z',
      article_count: 12,
      email_html: '<html>ok</html>',
      run_id: 'run-1',
      status: 'sent',
    });

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ run_id: 'run-1', status: 'sent' }),
      { onConflict: 'date' },
    );
    expect(upsert).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ run_id: expect.anything(), status: expect.anything() }),
      { onConflict: 'date' },
    );
  });

  it('getRecentDigests falls back to legacy columns when run_id/status are missing', async () => {
    const legacyRows = [
      {
        date: '2026-02-17',
        sent_at: '2026-02-17T06:58:35.812+00:00',
        article_count: 30,
        email_html: '<html>digest</html>',
      },
    ];

    const modernLimit = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '42703', message: 'column digests.run_id does not exist' },
    });
    const modernOrder = vi.fn(() => ({ limit: modernLimit }));

    const legacyLimit = vi.fn().mockResolvedValue({
      data: legacyRows,
      error: null,
    });
    const legacyOrder = vi.fn(() => ({ limit: legacyLimit }));

    const db = {
      from: vi.fn(() => ({
        select: vi.fn((columns: string) => {
          if (columns.includes('run_id')) return { order: modernOrder };
          return { order: legacyOrder };
        }),
      })),
    };

    const { store } = await loadStoreWithDb(db);
    const result = await store.getRecentDigests(5);

    expect(result).toEqual([
      {
        ...legacyRows[0],
        run_id: undefined,
        status: undefined,
      },
    ]);
    expect(modernOrder).toHaveBeenCalledWith('date', { ascending: false });
    expect(legacyOrder).toHaveBeenCalledWith('date', { ascending: false });
  });
});
