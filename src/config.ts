// ---------------------------------------------------------------------------
// Centralized configuration — all tunable constants in one place
// ---------------------------------------------------------------------------

import type OpenAI from 'openai';

/** AI processing */
export const AI = {
  /** Articles per AI batch */
  BATCH_SIZE: 6,
  /** DeepSeek model name (override with DEEPSEEK_MODEL if needed) */
  MODEL: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-pro',
  /** Max output tokens per AI call; reasoning tokens are billed against it */
  MAX_OUTPUT_TOKENS: 32_768,
  /** Max chars of article content sent to AI */
  CONTENT_LIMIT: 1500,
  /** Lower bound of digest size target */
  MIN_ARTICLES: 30,
  /** Degraded mode minimum: if strict-quality count reaches this, allow sending < MIN_ARTICLES */
  DEGRADED_MIN_ARTICLES: 8,
  /** If filling to 30 needs too many relaxed items, prefer degraded high-quality mode */
  MAX_RELAXED_TOPUP_FOR_FULL: 8,
  /** Minimum AI score to keep an article */
  MIN_SCORE: 6,
  /** Coarse filter threshold */
  COARSE_MIN_SCORE: 6,
  /** Fine filter threshold */
  FINE_MIN_SCORE: 6,
  /** Emergency fallback threshold when strict pool is too small */
  RELAXED_MIN_SCORE: 5,
  /** Prefer at least this many same-day items when available */
  FRESH_TARGET_MIN: 20,
  /** Minimum summary chars to avoid placeholder-style output */
  MIN_SUMMARY_CHARS: 45,
  /** Minimum evidence snippet length used for grounding checks */
  MIN_EVIDENCE_CHARS: 8,
  /** Maximum articles in the final digest */
  MAX_ARTICLES: 50,
  /** Retry attempts per batch */
  MAX_RETRIES: 2,
  /** Base delay between retries (doubles each attempt) */
  RETRY_BASE_MS: 1_000,
  /** Concurrent AI batch limit */
  MAX_CONCURRENCY: 3,
} as const;

/**
 * DeepSeek defaults `thinking` to enabled and `reasoning_effort` to high, and
 * reasoning tokens are billed against the completion budget — left implicit, a
 * provider-side default flip silently changes both cost and output. Every call
 * site therefore states its choice through these constants.
 *
 * Scoring and rerank are the quality steps and buy max effort (Director
 * ruling); the health check is a connectivity ping and buys none.
 */
export const DEEPSEEK_THINKING_ENABLED = { type: 'enabled' } as const;
export const DEEPSEEK_THINKING_DISABLED = { type: 'disabled' } as const;
export const DEEPSEEK_REASONING_EFFORT = 'max' as const;

/**
 * DeepSeek adds `thinking` to the OpenAI-compatible body and accepts only
 * low/high/max for `reasoning_effort`, narrower than the SDK union.
 */
export type DeepSeekChatParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    thinking?: { type: 'enabled' | 'disabled' };
    reasoning_effort?: 'low' | 'high' | 'max';
  };

/** Source health thresholds for non-blocking observability alerts */
export const SOURCE_HEALTH = {
  WEARESELLERS_MIN_ARTICLES: 5,
  REDDIT_MIN_ARTICLES: 1,
  SELLERCENTRAL_MIN_ARTICLES: 1,
  REDDIT_BOOST_TARGET: 10,
  REDDIT_BOOST_FALLBACK_MULTIPLIER: 8,
} as const;

/** Source caps for secondary sources (primary sources are uncapped) */
export const SOURCE_CAPS: Record<string, number> = {
  amz123: 10,
  sellercentral: 5,
};

/** Primary sources — discussions, experience, strategies (no cap) */
export const PRIMARY_SOURCES = new Set([
  'wearesellers',
  'reddit_fba',
  'reddit_seller',
]);

/** Collector settings */
export const COLLECTORS = {
  /** WeAreSellers */
  WEARESELLERS_MAX_LIST: 30,
  WEARESELLERS_MAX_DETAIL: 30,
  WEARESELLERS_DETAIL_DELAY_MS: 1_500,

  /** Reddit */
  REDDIT_POSTS_PER_SUB: 20,
  REDDIT_TIMEOUT_MS: 10_000,
  REDDIT_MAX_RETRIES: 2,
  REDDIT_RETRY_DELAY_MS: 2_000,
  REDDIT_MIN_SELFTEXT_CHARS: 1,
  REDDIT_COMMENT_ENRICH_MAX_POSTS: 8,
  REDDIT_COMMENTS_PER_POST: 4,
  REDDIT_COMMENT_MIN_CHARS: 20,
  REDDIT_CONTENT_LIMIT: 2_000,

  /** AMZ123 RSS */
  RSS_TIMEOUT_MS: 15_000,
  RSS_MAX_ITEMS: 30,

  /** Seller Central */
  SC_TIMEOUT_MS: 20_000,
  SC_MAX_POSTS: 30,
  SC_DETAIL_DELAY_MS: 1_500,
} as const;

/** Email delivery */
export const EMAIL = {
  MAX_RETRIES: 2,
  RETRY_DELAY_MS: 3_000,
} as const;
