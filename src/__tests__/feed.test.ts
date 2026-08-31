import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchFeed } from '../collectors/feed.js';

const VALID_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>feed</title>
<item><title>hello</title><link>https://www.amz123.com/news/1</link></item>
</channel></rss>`;

/** Small enough to keep the suite fast, large enough not to race the loopback. */
const FEED_TIMEOUT_MS = 300;
/** How long the server is given to notice the client hanging up. */
const CLOSE_GRACE_MS = 2_000;

let server: http.Server | undefined;
let accepted: Socket[] = [];

async function startServer(handler: http.RequestListener): Promise<string> {
  accepted = [];
  server = http.createServer(handler);
  server.on('connection', (socket) => accepted.push(socket));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/feed.rss`;
}

/**
 * The property under test: no request is left mid-flight holding a socket open.
 * Asserted from the server side, the only place a stranded client socket is
 * visible without reaching into Node internals. A request that finished cleanly
 * leaves its socket in Node's keep-alive pool, where the agent unrefs it — that
 * one does not keep the process alive and is not what this asserts.
 */
async function expectNoSocketLeftBehind(): Promise<void> {
  await expect
    .poll(() => accepted.length > 0 && accepted.every((socket) => socket.destroyed), {
      timeout: CLOSE_GRACE_MS,
    })
    .toBe(true);
}

afterEach(async () => {
  if (server) {
    const current = server;
    server = undefined;
    current.closeAllConnections();
    await new Promise<void>((resolve) => current.close(() => resolve()));
  }
});

describe('fetchFeed', () => {
  it('parses a feed that answers in time, twice in a row', async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(VALID_FEED);
    });

    const first = await fetchFeed(url, 5_000);
    // The second call proves the teardown does not cost the collector its next
    // fetch — collectRSS walks a list of mirrors in one run.
    const second = await fetchFeed(url, 5_000);

    expect(first.items).toHaveLength(1);
    expect(first.items[0].link).toBe('https://www.amz123.com/news/1');
    expect(second.items).toHaveLength(1);
  });

  it('hangs up on a mirror that accepts the request and then goes silent', async () => {
    // rss-parser rejects on its own timer without touching the request it
    // started, so an un-aborted request keeps a live, referenced socket for the
    // rest of the process — which is what stopped the pipeline ever exiting.
    const url = await startServer(() => {
      /* accept the request and never answer */
    });

    await expect(fetchFeed(url, FEED_TIMEOUT_MS)).rejects.toThrow(/timed out/i);

    await expectNoSocketLeftBehind();
  });

  it('hangs up on a mirror that rejects the request without a readable body', async () => {
    // The >=300 path leaves an unread response body, which pins the socket the
    // same way the timeout path does.
    const url = await startServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.write('blocked');
      // deliberately not ended: the body stays unread on the wire
    });

    await expect(fetchFeed(url, 5_000)).rejects.toThrow(/403/);

    await expectNoSocketLeftBehind();
  });

  it('hangs up on a redirect body it abandoned on the way to the feed', async () => {
    // rss-parser follows up to five redirects and never reads the body of the
    // responses it leaves behind, so even a successful parse can strand one.
    let abandoned: Socket | undefined;
    const url = await startServer((req, res) => {
      if (req.url === '/feed.rss') {
        abandoned = res.socket ?? undefined;
        res.writeHead(301, { Location: '/moved.rss', 'Content-Type': 'text/html' });
        res.write('<html>moved</html>');
        // deliberately not ended: this is the response rss-parser walks away from
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(VALID_FEED);
    });

    const feed = await fetchFeed(url, 5_000);

    expect(feed.items).toHaveLength(1);
    await expect
      .poll(() => abandoned?.destroyed === true, { timeout: CLOSE_GRACE_MS })
      .toBe(true);
  });
});
