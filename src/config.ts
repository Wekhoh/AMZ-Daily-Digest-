// ---------------------------------------------------------------------------
// Centralized configuration — all tunable constants in one place
// ---------------------------------------------------------------------------

import type OpenAI from 'openai';

/** AI processing */
export const AI = {
  /** Articles per AI batch */
  BATCH_SIZE: 6,
  /** Chat model name (override with LLM_MODEL if needed) */
  MODEL: process.env.LLM_MODEL?.trim() || 'glm-5.3-flash',
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

/** OpenAI-compatible base URL of the chat provider (override with LLM_BASE_URL) */
export const LLM_BASE_URL =
  process.env.LLM_BASE_URL?.trim() || 'https://open.bigmodel.cn/api/paas/v4/';

/**
 * `enabled` is the only value GLM-5.3 / GLM-5.3-Flash accept — they think
 * unconditionally and reject a request that asks them to stop. There is
 * deliberately no disabled counterpart here for a later change to reach for.
 */
export const LLM_THINKING_ENABLED = { type: 'enabled' } as const;

/**
 * Reasoning tokens are billed against the completion budget, so the effort tier
 * is a cost lever rather than a style knob. An absent or unrecognised value
 * means `max` on this provider, so passing it explicitly is not redundant: it
 * puts the tier in the request where it can be read, and behind an env var
 * where it can be changed without a code edit.
 *
 * `max` stands per the Director ruling that scoring and rerank buy max effort;
 * the health check opts down on its own, being a connectivity ping.
 */
export const LLM_REASONING_EFFORT = (process.env.LLM_REASONING_EFFORT?.trim() ||
  'max') as 'low' | 'high' | 'max';

/**
 * The provider adds `thinking` to the OpenAI-compatible body and accepts only
 * low/high/max for `reasoning_effort`, narrower than the SDK union.
 */
export type LlmChatParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    thinking?: { type: 'enabled' };
    reasoning_effort?: 'low' | 'high' | 'max';
  };

export type LlmChatStreamingParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
    thinking?: { type: 'enabled' };
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
  amazon_official: 5,
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

  /** Amazon official announcements (SP-API changelog RSS) */
  OFFICIAL_TIMEOUT_MS: 15_000,
  OFFICIAL_MAX_ITEMS: 10,
  OFFICIAL_MAX_AGE_DAYS: 30,
} as const;

/** Email delivery */
export const EMAIL = {
  MAX_RETRIES: 2,
  RETRY_DELAY_MS: 3_000,
} as const;
