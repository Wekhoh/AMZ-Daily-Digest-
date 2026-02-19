/**
 * Validate that a URL belongs to an allowed domain list.
 * Blocks javascript:, data:, file:, and internal network URLs (SSRF protection).
 */
export function isSafeUrl(url: string, allowedDomains: string[]): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    return allowedDomains.some((d) => {
      const domain = d.toLowerCase();
      return hostname === domain || hostname.endsWith('.' + domain);
    });
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TRACKING_PARAM_PREFIXES = [
  'utm_',
];

const TRACKING_PARAM_EXACT = new Set([
  'fbclid',
  'gclid',
  'msclkid',
  'spm',
  'ref',
  'ref_',
]);

/**
 * Normalize URL for dedupe:
 * - allow only http/https
 * - lower-case hostname
 * - remove fragment/hash
 * - remove common tracking params
 * - sort query params for stable ordering
 * - remove trailing slash (except root)
 */
export function canonicalizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }

    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();

    const cleanedParams = new URLSearchParams();
    for (const [key, value] of parsed.searchParams) {
      const lower = key.toLowerCase();
      const isTrackingPrefix = TRACKING_PARAM_PREFIXES.some((p) =>
        lower.startsWith(p)
      );
      const isTrackingExact = TRACKING_PARAM_EXACT.has(lower);
      if (isTrackingPrefix || isTrackingExact) continue;
      cleanedParams.append(key, value);
    }

    const sorted = [...cleanedParams.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    );
    parsed.search = sorted.length > 0
      ? `?${new URLSearchParams(sorted).toString()}`
      : '';

    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    return null;
  }
}
