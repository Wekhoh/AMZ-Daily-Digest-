// ---------------------------------------------------------------------------
// Centralized configuration — all tunable constants in one place
// ---------------------------------------------------------------------------

/** AI processing */
export const AI = {
  /** Articles per Gemini batch */
  BATCH_SIZE: 10,
  /** Max chars of article content sent to AI */
  CONTENT_LIMIT: 1500,
  /** Minimum AI score to keep an article */
  MIN_SCORE: 6,
  /** Maximum articles in the final digest */
  MAX_ARTICLES: 50,
  /** Retry attempts per batch */
  MAX_RETRIES: 2,
  /** Base delay between retries (doubles each attempt) */
  RETRY_BASE_MS: 1_000,
  /** Concurrent AI batch limit */
  MAX_CONCURRENCY: 3,
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
