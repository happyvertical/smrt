import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentFeedSource } from './content-feed-source';
import { syncContentFeedSource } from './content-feed-sync';
import { Contents } from './contents';

const PUBLIC_RESOLVER = async () => [{ address: '93.184.216.34', family: 4 }];
const FIXED_NOW = new Date('2026-05-09T12:00:00.000Z');

function createSource(options: Partial<ContentFeedSource> = {}) {
  const source = new ContentFeedSource({
    id: 'source-1',
    tenantId: 'tenant-1',
    name: 'Regional Wire',
    feedUrl: 'https://feeds.example.test/rss.xml',
    homepageUrl: 'https://example.test/',
    ...options,
  });
  source.save = vi.fn(async () => source) as typeof source.save;
  return source;
}

function createRssFeed() {
  return `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <title>Regional Wire</title>
        <link>https://example.test/</link>
        <item>
          <title>Fresh story</title>
          <link>https://example.test/fresh</link>
          <guid>fresh-guid</guid>
          <pubDate>Sat, 09 May 2026 12:00:00 GMT</pubDate>
          <description>Fresh summary</description>
        </item>
        <item>
          <title>Existing story</title>
          <link>https://example.test/existing</link>
          <guid>existing-guid</guid>
        </item>
        <item>
          <title>Broken story</title>
          <link>https://example.test/broken</link>
          <guid>broken-guid</guid>
        </item>
      </channel>
    </rss>`;
}

async function startFeedFixture(
  handler: Parameters<typeof createServer>[0],
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Feed fixture did not expose a TCP port');
  }
  return { server, port: address.port };
}

async function closeFeedFixture(server: Server): Promise<void> {
  server.close();
  await once(server, 'close');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('syncContentFeedSource', () => {
  it('marks a source successful without importing rows on HTTP 304', async () => {
    const source = createSource({
      etag: '"old"',
      lastModified: 'Sat, 09 May 2026 10:00:00 GMT',
    });
    const fetch = vi.fn(async () => new Response(null, { status: 304 }));
    const createSpy = vi.spyOn(Contents, 'create');

    const result = await syncContentFeedSource(source, {
      fetch,
      now: () => FIXED_NOW,
      resolveHostname: PUBLIC_RESOLVER,
    });

    expect(result).toMatchObject({
      fetched: true,
      notModified: true,
      imported: 0,
      updated: 0,
      skipped: 0,
    });
    expect(source.lastSuccessAt?.toISOString()).toBe(FIXED_NOW.toISOString());
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://feeds.example.test/rss.xml'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'If-None-Match': '"old"',
          'If-Modified-Since': 'Sat, 09 May 2026 10:00:00 GMT',
        }),
      }),
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('keeps a disabled fetch timeout disabled for injected transports', async () => {
    const source = createSource();
    const fetch = vi.fn(async () => new Response(null, { status: 304 }));

    await syncContentFeedSource(source, {
      fetch,
      fetchTimeoutMs: 0,
      now: () => FIXED_NOW,
      resolveHostname: PUBLIC_RESOLVER,
    });

    expect(fetch.mock.calls[0][1]?.signal).toBeUndefined();
  });

  it('imports, updates, and skips feed items while preserving source scope', async () => {
    const source = createSource();
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('AND source_guid = ?')) {
        return params.at(-1) === 'existing-guid'
          ? [{ id: 'existing-content', status: 'draft' }]
          : [];
      }
      if (sql.includes('AND dedupe_key = ?')) return [];
      if (sql.startsWith('INSERT') && params[4] === 'Broken story') {
        throw new Error('insert failed');
      }
      return [];
    });
    vi.spyOn(Contents, 'create').mockResolvedValue({
      query,
    } as unknown as Contents);
    const fetch = vi.fn(
      async () =>
        new Response(createRssFeed(), {
          status: 200,
          headers: {
            etag: '"next"',
            'last-modified': 'Sat, 09 May 2026 11:59:00 GMT',
          },
        }),
    );

    const result = await syncContentFeedSource(source, {
      fetch,
      now: () => FIXED_NOW,
      resolveHostname: PUBLIC_RESOLVER,
    });

    expect(result).toMatchObject({
      fetched: true,
      notModified: false,
      imported: 1,
      updated: 1,
      skipped: 1,
    });
    expect(source.etag).toBe('"next"');
    expect(source.lastModified).toBe('Sat, 09 May 2026 11:59:00 GMT');

    const fallbackQuery = queries.find(({ sql }) =>
      sql.includes('AND dedupe_key = ?'),
    );
    expect(fallbackQuery?.sql).toContain('AND feed_source_id = ?');
    expect(fallbackQuery?.params).toContain(source.id);

    const insertQuery = queries.find(({ sql }) => sql.startsWith('INSERT'));
    expect(insertQuery?.params[3]).toBe('@happyvertical/smrt-content:Mirror');
  });

  it('rejects private-network feed URLs before fetching', async () => {
    const source = createSource({
      feedUrl: 'http://127.0.0.1:6379/feed.xml',
    });
    const fetch = vi.fn();

    await expect(
      syncContentFeedSource(source, {
        fetch,
        now: () => FIXED_NOW,
      }),
    ).rejects.toThrow('public network address');

    expect(fetch).not.toHaveBeenCalled();
    expect(source.status).toBe('error');
    expect(source.lastError).toContain('public network address');
  });

  it('re-validates redirect targets and blocks a redirect to a private host (S5 #1388)', async () => {
    const source = createSource();
    // The initial public host passes validation, then 302s to a loopback
    // address. With default redirect-following this SSRF would succeed; the
    // manual-redirect guard must re-run the host check on the Location target.
    const fetch = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:6379/internal.xml' },
      });
    });

    await expect(
      syncContentFeedSource(source, {
        fetch,
        now: () => FIXED_NOW,
        // First (public) host resolves public; the redirect target is a literal
        // IP, so it never hits the resolver and is rejected by isBlockedAddress.
        resolveHostname: PUBLIC_RESOLVER,
      }),
    ).rejects.toThrow('public network address');

    // Only the first hop was fetched; the redirect target was rejected before
    // any request to the internal host.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(source.status).toBe('error');
  });

  it('follows a redirect to another public host (S5 #1388)', async () => {
    const source = createSource();
    const resolveHostname = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
    ]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://mirror.example.test/rss.xml' },
        }),
      )
      .mockResolvedValueOnce(new Response(createRssFeed(), { status: 200 }));
    vi.spyOn(Contents, 'create').mockResolvedValue({
      query: vi.fn(async () => []),
    } as unknown as Contents);

    const result = await syncContentFeedSource(source, {
      fetch,
      now: () => FIXED_NOW,
      resolveHostname,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0].toString()).toBe(
      'https://mirror.example.test/rss.xml',
    );
    expect(result.fetched).toBe(true);
  });

  it('pins each validated DNS address instead of re-resolving the initial or redirect hostname (#3418)', async () => {
    let port = 0;
    const receivedHosts: string[] = [];
    const { server, port: fixturePort } = await startFeedFixture(
      (request, response) => {
        receivedHosts.push(request.headers.host ?? '');
        if (request.url === '/start') {
          response.writeHead(302, {
            location: `http://redirect.rebind.test:${port}/rss.xml`,
          });
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/rss+xml' });
        response.end(createRssFeed());
      },
    );
    port = fixturePort;

    try {
      const source = createSource({
        feedUrl: `http://initial.rebind.test:${port}/start`,
      });
      let initialHostRebound = false;
      const resolveHostname = vi.fn(async (hostname: string) => {
        // The test hostnames have no system DNS records. Each address is a
        // local-only fixture and represents the validator's one-time snapshot.
        // The initial host changes to a private answer immediately afterward;
        // the established request must still use the validated snapshot.
        if (hostname === 'initial.rebind.test') {
          if (initialHostRebound) {
            return [{ address: '169.254.169.254', family: 4 }];
          }
          initialHostRebound = true;
          return [{ address: '127.0.0.1', family: 4 }];
        }
        if (hostname === 'redirect.rebind.test') {
          return [{ address: '127.0.0.1', family: 4 }];
        }
        return [{ address: '169.254.169.254', family: 4 }];
      });
      vi.spyOn(Contents, 'create').mockResolvedValue({
        query: vi.fn(async () => []),
      } as unknown as Contents);

      const result = await syncContentFeedSource(source, {
        allowPrivateNetworkHosts: true,
        now: () => FIXED_NOW,
        resolveHostname,
      });

      expect(result.fetched).toBe(true);
      expect(resolveHostname).toHaveBeenCalledTimes(2);
      expect(resolveHostname).toHaveBeenNthCalledWith(1, 'initial.rebind.test');
      expect(resolveHostname).toHaveBeenNthCalledWith(
        2,
        'redirect.rebind.test',
      );
      expect(initialHostRebound).toBe(true);
      // A later DNS answer for the initial hostname is private. The successful
      // fixture request above proves the request used the earlier validated
      // address instead of resolving again at connection time.
      await expect(resolveHostname('initial.rebind.test')).resolves.toEqual([
        { address: '169.254.169.254', family: 4 },
      ]);
      expect(receivedHosts).toEqual([
        `initial.rebind.test:${port}`,
        `redirect.rebind.test:${port}`,
      ]);
    } finally {
      await closeFeedFixture(server);
    }
  });

  it('rejects feeds that exceed the redirect limit (S5 #1388)', async () => {
    const source = createSource();
    const resolveHostname = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
    ]);
    let hop = 0;
    const fetch = vi.fn(async () => {
      hop += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://hop-${hop}.example.test/rss.xml` },
      });
    });

    await expect(
      syncContentFeedSource(source, {
        fetch,
        now: () => FIXED_NOW,
        resolveHostname,
      }),
    ).rejects.toThrow('maximum number of redirects');
  });

  it('caps feed response bodies before parsing', async () => {
    const source = createSource();
    const fetch = vi.fn(
      async () =>
        new Response('x'.repeat(32), {
          status: 200,
        }),
    );

    await expect(
      syncContentFeedSource(source, {
        fetch,
        maxResponseBytes: 8,
        now: () => FIXED_NOW,
        resolveHostname: PUBLIC_RESOLVER,
      }),
    ).rejects.toThrow('exceeds 8 bytes');
  });
});
