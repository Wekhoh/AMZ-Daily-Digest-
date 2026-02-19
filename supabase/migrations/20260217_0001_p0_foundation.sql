-- ---------------------------------------------------------------------------
-- P0 foundation: idempotent run lock + subscriber/delivery foundations
-- ---------------------------------------------------------------------------

-- Track each pipeline run and enforce one active/sent run per day.
CREATE TABLE IF NOT EXISTS digest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID UNIQUE NOT NULL,
  digest_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'sent', 'failed', 'skipped')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  article_count INT NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_runs_date_active
  ON digest_runs (digest_date)
  WHERE status IN ('running', 'sent');

CREATE INDEX IF NOT EXISTS idx_digest_runs_date_started
  ON digest_runs (digest_date, started_at DESC);

-- Extend digests for run correlation and explicit state.
ALTER TABLE digests
  ADD COLUMN IF NOT EXISTS run_id UUID;

ALTER TABLE digests
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sent';

CREATE INDEX IF NOT EXISTS idx_digests_run_id
  ON digests (run_id);

-- Subscriber registry (single account, multi recipients).
CREATE TABLE IF NOT EXISTS subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscribers_active
  ON subscribers (active, created_at DESC);

-- Per-subscriber delivery tracking (future batch integration).
CREATE TABLE IF NOT EXISTS digest_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES digest_runs(run_id) ON DELETE CASCADE,
  subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS idx_digest_deliveries_run_status
  ON digest_deliveries (run_id, status);

-- Canonical URL dedupe foundation for articles.
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS raw_url TEXT;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS canonical_url TEXT;

UPDATE articles
SET
  raw_url = COALESCE(raw_url, url),
  canonical_url = COALESCE(canonical_url, url)
WHERE raw_url IS NULL OR canonical_url IS NULL;

ALTER TABLE articles
  ALTER COLUMN raw_url SET NOT NULL;

ALTER TABLE articles
  ALTER COLUMN canonical_url SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_canonical_url
  ON articles (canonical_url);

CREATE INDEX IF NOT EXISTS idx_articles_raw_url
  ON articles (raw_url);
