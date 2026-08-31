import Parser from 'rss-parser';

/** Shared by every RSS-backed collector; the feeds need no distinct identities. */
const FEED_USER_AGENT = 'amz-daily-digest/1.0';

/**
 * Fetch and parse one feed, guaranteeing no request is left holding a socket.
 *
 * rss-parser 3.13 never touches the `http.get` it started: it rejects `parseURL`
 * from its own `setTimeout`, it rejects a >=300 status without reading the
 * response body, and on a redirect it walks away from the first response unread.
 * Each of those leaves a request mid-flight, and a mid-flight request keeps its
 * socket referenced for the rest of the process. That is what kept the digest
 * alive after it had finished all of its work: the pipeline printed its
 * completion banner and the process still would not exit, so the publish step
 * never ran and the job died at the Actions 30-minute ceiling (runs 32339754673
 * on 2026-08-20 and 33391617392 on 2026-08-31, both preceded by two RSSHub
 * mirrors timing out).
 *
 * Owning the AbortSignal lets us reclaim the request on every path instead of
 * enumerating the leaky ones. The signal must be per-request, so the parser
 * cannot be a shared singleton. Aborting in `finally` is free on the clean path:
 * Node drops the abort listener once a request has ended, so a feed that parsed
 * keeps the keep-alive socket it earned — which the agent unrefs anyway.
 */
export async function fetchFeed(
  url: string,
  timeoutMs: number,
): Promise<Awaited<ReturnType<Parser['parseURL']>>> {
  const controller = new AbortController();
  const parser = new Parser({
    timeout: timeoutMs,
    headers: { 'User-Agent': FEED_USER_AGENT },
    requestOptions: { signal: controller.signal },
  });

  try {
    return await parser.parseURL(url);
  } finally {
    controller.abort();
  }
}
