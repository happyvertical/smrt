import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeTypedHttpError } from './generators/typed-http-error.js';
import {
  BoundedSlidingWindowRateLimiter,
  createNodeHttpHandler,
  extractClientIp,
  formatBodyLimitMessage,
  HttpBadRequestError,
  HttpPayloadTooLargeError,
  HttpTooManyRequestsError,
  isJsonContentType,
  normalizeIpAddress,
  parseJsonRequestBody,
  parseOptionalJsonRequestBody,
  readBoundedBody,
} from './http.js';

describe('@happyvertical/smrt-core/http helpers (#5674)', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('integrates HTTP error classes cleanly with normalizeTypedHttpError', () => {
    expect(
      normalizeTypedHttpError(new HttpBadRequestError('bad json')),
    ).toEqual({
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'bad json',
    });
    expect(
      normalizeTypedHttpError(new HttpPayloadTooLargeError('too big')),
    ).toEqual({
      ok: false,
      status: 413,
      code: 'payload_too_large',
      message: 'too big',
    });
    const rateErr = new HttpTooManyRequestsError('slow down', 12.2);
    expect(rateErr.retryAfterSeconds).toBe(13);
    expect(normalizeTypedHttpError(rateErr)).toEqual({
      ok: false,
      status: 429,
      code: 'too_many_requests',
      message: 'slow down',
    });
  });

  it('validates content types and enforces streaming + declared byte bounds', async () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
    expect(formatBodyLimitMessage(64 * 1024)).toBe(
      'Request body exceeds 64 KiB limit',
    );
    expect(formatBodyLimitMessage(2 * 1024 * 1024)).toBe(
      'Request body exceeds 2 MiB limit',
    );

    const validReq = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ hello: 'world' }),
    });
    await expect(parseJsonRequestBody(validReq, 1024)).resolves.toEqual({
      hello: 'world',
    });

    const emptyOptReq = new Request('http://localhost/test', {
      method: 'POST',
    });
    await expect(
      parseOptionalJsonRequestBody(emptyOptReq, 1024),
    ).resolves.toEqual({});

    const wrongTypeReq = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"a":1}',
    });
    await expect(
      parseJsonRequestBody(wrongTypeReq, 1024),
    ).rejects.toBeInstanceOf(HttpBadRequestError);

    const invalidUtf8Req = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]),
    });
    await expect(
      parseJsonRequestBody(invalidUtf8Req, 1024),
    ).rejects.toBeInstanceOf(HttpBadRequestError);

    // Oversized declared Content-Length fails before consuming stream
    let streamPulled = false;
    const oversizedDeclared = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-length': '2048' },
      body: new ReadableStream(
        {
          pull(controller) {
            streamPulled = true;
            controller.enqueue(new Uint8Array(10));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      duplex: 'half',
    } as RequestInit);
    await expect(
      readBoundedBody(oversizedDeclared, 128),
    ).rejects.toBeInstanceOf(HttpPayloadTooLargeError);
    expect(streamPulled).toBe(false);

    // Oversized chunked stream without Content-Length cancels mid-stream
    let cancelled = false;
    const oversizedStream = new Request('http://localhost/test', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(80));
          controller.enqueue(new Uint8Array(80));
        },
        cancel() {
          cancelled = true;
        },
      }),
      duplex: 'half',
    } as RequestInit);
    await expect(readBoundedBody(oversizedStream, 100)).rejects.toBeInstanceOf(
      HttpPayloadTooLargeError,
    );
    expect(cancelled).toBe(true);

    // Cloned (`tee()`d) oversized requests reject immediately even with unread sibling
    const clonedDeclaredParent = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-length': '2048' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(64));
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const clonedDeclaredSibling = clonedDeclaredParent.clone();
    await expect(
      readBoundedBody(clonedDeclaredParent, 128),
    ).rejects.toBeInstanceOf(HttpPayloadTooLargeError);
    void clonedDeclaredSibling.body?.cancel();

    const clonedStreamParent = new Request('http://localhost/test', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(80));
          controller.enqueue(new Uint8Array(80));
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const clonedStreamSibling = clonedStreamParent.clone();
    await expect(
      readBoundedBody(clonedStreamParent, 100),
    ).rejects.toBeInstanceOf(HttpPayloadTooLargeError);
    void clonedStreamSibling.body?.cancel();
  });

  it('extracts client IPs safely from right-to-left X-Forwarded-For hops', () => {
    expect(normalizeIpAddress('::ffff:198.51.100.7')).toBe('198.51.100.7');
    const req = new Request('http://localhost/api', {
      headers: {
        'x-forwarded-for': '203.0.113.99, 198.51.100.42, ::ffff:10.0.0.5',
      },
    });
    // Untrusted proxy (hops = 0) ignores X-Forwarded-For completely
    expect(extractClientIp(req, '::ffff:127.0.0.1', 0)).toBe('127.0.0.1');
    // 1 trusted hop picks rightmost proxy entry
    expect(extractClientIp(req, '::ffff:127.0.0.1', 1)).toBe('10.0.0.5');
    // 2 trusted hops picks second from right, resisting leftmost spoofing
    expect(extractClientIp(req, '::ffff:127.0.0.1', 2)).toBe('198.51.100.42');
  });

  it('enforces LRU-bounded sliding-window rate limits and refunds', () => {
    const limiter = new BoundedSlidingWindowRateLimiter({
      maxEvents: 2,
      windowMs: 10_000,
      maxEntries: 2,
    });
    expect(limiter.check('alice', 1_000)).toBeNull();
    limiter.record('alice', 1_000);
    limiter.record('alice', 2_000);
    expect(limiter.check('alice', 3_000)).toBe(8);

    // Refunding one attempt restores availability immediately
    limiter.refundOne('alice', 2_000);
    expect(limiter.check('alice', 3_000)).toBeNull();

    // LRU cap evicts oldest key when full
    limiter.record('bob', 4_000);
    limiter.record('charlie', 5_000);
    expect(limiter.size).toBe(2);
    expect(limiter.check('alice', 5_000)).toBeNull();

    // Window expiry clears bob after 10s
    limiter.record('bob', 5_500);
    expect(limiter.check('bob', 6_000)).toBe(8);
    expect(limiter.check('bob', 16_000)).toBeNull();
  });

  it('bridges Node http.Server requests with streaming 413 protection and multi Set-Cookie headers', async () => {
    const handler = createNodeHttpHandler(
      async (request, remoteAddress) => {
        const url = new URL(request.url);
        if (url.pathname === '/cookies') {
          const headers = new Headers({ 'content-type': 'application/json' });
          headers.append('set-cookie', 'a=1; Path=/; HttpOnly');
          headers.append('set-cookie', 'b=2; Path=/; HttpOnly');
          return new Response(
            JSON.stringify({
              proto: url.protocol,
              ip: extractClientIp(request, remoteAddress, 1),
            }),
            { status: 200, headers },
          );
        }
        const body = await parseJsonRequestBody<{ echo: string }>(request, 128);
        return new Response(JSON.stringify({ got: body.echo }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      {
        maxBodyBytes: 128,
        trustProxyHops: 1,
      },
    );

    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;

    const okRes = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ echo: 'ok' }),
    });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ got: 'ok' });

    const tooBigRes = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ echo: 'x'.repeat(256) }),
    });
    expect(tooBigRes.status).toBe(413);

    const cookieRes = await fetch(`http://127.0.0.1:${port}/cookies`, {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.7',
      },
    });
    expect(cookieRes.status).toBe(200);
    expect(cookieRes.headers.getSetCookie()).toEqual([
      'a=1; Path=/; HttpOnly',
      'b=2; Path=/; HttpOnly',
    ]);
    expect(await cookieRes.json()).toEqual({
      proto: 'https:',
      ip: '203.0.113.7',
    });

    // Client-prepended X-Forwarded-Proto cannot spoof HTTPS when proxy appends http
    const spoofedProtoRes = await fetch(`http://127.0.0.1:${port}/cookies`, {
      headers: {
        'x-forwarded-proto': 'https, http',
        'x-forwarded-for': '198.51.100.1, 203.0.113.7',
      },
    });
    expect(await spoofedProtoRes.json()).toEqual({
      proto: 'http:',
      ip: '203.0.113.7',
    });

    const multiHopTlsRes = await fetch(`http://127.0.0.1:${port}/cookies`, {
      headers: {
        'x-forwarded-proto': 'http, https',
        'x-forwarded-for': '198.51.100.1, 203.0.113.7',
      },
    });
    expect(await multiHopTlsRes.json()).toEqual({
      proto: 'https:',
      ip: '203.0.113.7',
    });

    // Chunked Transfer-Encoding (no Content-Length) exceeding maxBodyBytes returns 413 cleanly
    const chunkedResult = await new Promise<{
      status: number;
      connection: string | undefined;
      body: string;
    }>((resolve, reject) => {
      const clientReq = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/echo',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
          },
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (c: Buffer) => parts.push(c));
          res.on('end', () => {
            clientReq.destroy();
            resolve({
              status: res.statusCode ?? 0,
              connection: res.headers.connection,
              body: Buffer.concat(parts).toString('utf8'),
            });
          });
        },
      );
      clientReq.on('error', reject);
      clientReq.write('{"echo":"');
      clientReq.write('z'.repeat(200));
    });
    expect(chunkedResult.status).toBe(413);
    expect(chunkedResult.connection).toBe('close');
    expect(JSON.parse(chunkedResult.body)).toEqual({
      error: 'Request body exceeds 128 byte limit',
    });
  });

  it('survives throwing onError mappers, distinguishes fetch-decoded vs pre-compressed gzip responses, and clears partial headers on failure', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const upstream = createServer((req, res) => {
        if (req.url === '/head-plain' && req.method === 'HEAD') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': '4096',
          });
          res.end();
          return;
        }
        if (req.url === '/stacked') {
          const raw = Buffer.from(JSON.stringify({ stacked: 'ok' }));
          const stacked = brotliCompressSync(gzipSync(raw));
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-encoding': 'gzip, br',
            'content-length': String(stacked.byteLength),
          });
          res.end(stacked);
          return;
        }
        const gz = gzipSync(Buffer.from(JSON.stringify({ upstream: 'ok' })));
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': String(gz.byteLength),
        });
        res.end(gz);
      });
      servers.push(upstream);
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', resolve),
      );
      const { port: upstreamPort } = upstream.address() as AddressInfo;

      const server = createServer(
        createNodeHttpHandler(
          async (request) => {
            const url = new URL(request.url);
            if (url.pathname === '/proxy') {
              return fetch(`http://127.0.0.1:${upstreamPort}/data`);
            }
            if (url.pathname === '/proxy-stacked') {
              return fetch(`http://127.0.0.1:${upstreamPort}/stacked`);
            }
            if (url.pathname === '/proxy-head' && request.method === 'HEAD') {
              return fetch(`http://127.0.0.1:${upstreamPort}/head-plain`, {
                method: 'HEAD',
              });
            }
            if (url.pathname === '/head-meta' && request.method === 'HEAD') {
              return new Response(null, {
                status: 200,
                headers: {
                  'content-type': 'application/json',
                  'content-length': '42',
                },
              });
            }
            if (url.pathname === '/precompressed') {
              const gz = gzipSync(
                Buffer.from(JSON.stringify({ precompressed: true })),
              );
              return new Response(new Uint8Array(gz), {
                status: 200,
                headers: {
                  'content-type': 'application/json',
                  'content-encoding': 'gzip',
                },
              });
            }
            if (url.pathname === '/bad-header') {
              const headers = new Headers();
              headers.append('set-cookie', 'leaked=1; Path=/');
              headers.set('x-invalid', 'bad\u0001value');
              return new Response('ok', { status: 200, headers });
            }
            throw new Error('handler exploded');
          },
          {
            onError: () => {
              throw new Error('onError also exploded');
            },
          },
        ),
      );
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const { port } = server.address() as AddressInfo;

      const boomRes = await fetch(`http://127.0.0.1:${port}/boom`);
      expect(boomRes.status).toBe(500);
      expect(await boomRes.json()).toEqual({ error: 'Internal server error' });

      const proxyRes = await fetch(`http://127.0.0.1:${port}/proxy`);
      expect(proxyRes.status).toBe(200);
      expect(proxyRes.headers.get('content-encoding')).toBeNull();
      expect(await proxyRes.json()).toEqual({ upstream: 'ok' });

      const stackedRes = await fetch(`http://127.0.0.1:${port}/proxy-stacked`);
      expect(stackedRes.status).toBe(200);
      expect(stackedRes.headers.get('content-encoding')).toBeNull();
      expect(await stackedRes.json()).toEqual({ stacked: 'ok' });

      const headRes = await fetch(`http://127.0.0.1:${port}/head-meta`, {
        method: 'HEAD',
      });
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get('content-length')).toBe('42');

      const proxyHeadRes = await fetch(`http://127.0.0.1:${port}/proxy-head`, {
        method: 'HEAD',
      });
      expect(proxyHeadRes.status).toBe(200);
      expect(proxyHeadRes.headers.get('content-length')).toBe('4096');

      const precompRes = await fetch(`http://127.0.0.1:${port}/precompressed`);
      expect(precompRes.status).toBe(200);
      expect(precompRes.headers.get('content-encoding')).toBe('gzip');
      expect(await precompRes.json()).toEqual({ precompressed: true });

      const badHeaderRes = await fetch(`http://127.0.0.1:${port}/bad-header`);
      expect(badHeaderRes.status).toBe(500);
      expect(badHeaderRes.headers.getSetCookie()).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
