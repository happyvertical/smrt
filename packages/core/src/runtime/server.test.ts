/**
 * Tests for the SMRT runtime HTTP server (src/runtime/server.ts).
 *
 * The bulk of SmrtServer is request-routing logic that does not require a live
 * socket: route registration, :param matching, the Express-style response
 * adapter, CORS handling, and bearer/basic/custom auth. We drive these through
 * the server's request handler with synthetic Web `Request` objects so no port
 * is ever opened.
 *
 * The socket-bound path (start(), nodeIngress(), streamToBuffer()) is
 * exercised only by the body-limit tests that bind an ephemeral port.
 */

import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createSmrtServer, SmrtServerConfigError } from './index.js';
import type { SmrtServerOptions } from './types.js';

// The server module's logger passes through; only `error` is observable so the
// disconnect tests can assert nothing was reported as a request error.
const loggerError = vi.hoisted(() => vi.fn());
vi.mock('@happyvertical/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/logger')>();
  return {
    ...actual,
    createLogger: (...args: Parameters<typeof actual.createLogger>) => {
      const real = actual.createLogger(...args);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'error') return loggerError;
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

// SmrtServer is not re-exported from runtime/index, so build it via the factory.
// dispatch() is the supported public in-process entry point (no socket bound).
function makeServer(options?: SmrtServerOptions) {
  const server = createSmrtServer(options);
  const dispatch = (request: Request): Promise<Response> =>
    server.dispatch(request);
  return { server, dispatch };
}

const BASE = 'http://localhost:3000';

describe('createSmrtServer', () => {
  it('returns a server instance', () => {
    const server = createSmrtServer();
    expect(server).toBeDefined();
    expect(typeof server.addRoute).toBe('function');
  });
});

describe('route dispatch', () => {
  it('returns 404 when no route matches', async () => {
    const { dispatch } = makeServer({ cors: false });
    const res = await dispatch(new Request(`${BASE}/api/v1/unknown`));
    expect(res.status).toBe(404);
  });

  it('dispatches an exact-match route', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute('GET', '/ping', async () => new Response('pong'));

    const res = await dispatch(new Request(`${BASE}/api/v1/ping`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pong');
  });

  it('extracts :params from a parameterized route', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute(
      'GET',
      '/users/:id',
      async (req) => new Response(req.params.id),
    );

    const res = await dispatch(new Request(`${BASE}/api/v1/users/42`));
    expect(await res.text()).toBe('42');
  });

  it('does not match when segment counts differ', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute('GET', '/users/:id', async () => new Response('ok'));

    const res = await dispatch(new Request(`${BASE}/api/v1/users/42/extra`));
    expect(res.status).toBe(404);
  });

  it('does not match when a literal segment differs', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute('GET', '/users/:id', async () => new Response('ok'));

    // Method matches but the literal prefix "users" is "teams" here.
    const res = await dispatch(new Request(`${BASE}/api/v1/teams/42`));
    expect(res.status).toBe(404);
  });

  it('parses JSON bodies for POST requests', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute('POST', '/echo', async (req) => {
      const data = await req.json();
      return new Response(JSON.stringify(data));
    });

    const res = await dispatch(
      new Request(`${BASE}/api/v1/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      }),
    );
    expect(await res.json()).toEqual({ hello: 'world' });
  });

  it('parses query parameters', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute('GET', '/search', async (req) => new Response(req.query.q));

    const res = await dispatch(new Request(`${BASE}/api/v1/search?q=term`));
    expect(await res.text()).toBe('term');
  });

  it('returns 500 when a handler throws', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute('GET', '/boom', async () => {
      throw new Error('kaboom');
    });

    const res = await dispatch(new Request(`${BASE}/api/v1/boom`));
    expect(res.status).toBe(500);
  });
});

describe('Express-style route adapters', () => {
  it('adapts res.status().json() into a Response', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.get('/widget', (_req, res) => {
      res.status(201).json({ created: true });
    });

    const res = await dispatch(new Request(`${BASE}/api/v1/widget`));
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ created: true });
  });

  it('adapts res.send() with a string to text/plain', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.post('/note', (_req, res) => {
      res.send('plain body');
    });

    const res = await dispatch(
      new Request(`${BASE}/api/v1/note`, { method: 'POST' }),
    );
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('plain body');
  });

  it('adapts res.send() with an object to application/json', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.put('/note', (_req, res) => {
      res.send({ ok: 1 });
    });

    const res = await dispatch(
      new Request(`${BASE}/api/v1/note`, { method: 'PUT' }),
    );
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ ok: 1 });
  });

  it('adapts res.setHeader() and res.end()', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.delete('/note', (_req, res) => {
      res.setHeader('X-Custom', 'yes');
      res.end('done');
    });

    const res = await dispatch(
      new Request(`${BASE}/api/v1/note`, { method: 'DELETE' }),
    );
    expect(res.headers.get('x-custom')).toBe('yes');
    expect(await res.text()).toBe('done');
  });

  it('propagates a synchronous throw from an Express handler as 500', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.get('/fail', () => {
      throw new Error('sync fail');
    });

    const res = await dispatch(new Request(`${BASE}/api/v1/fail`));
    expect(res.status).toBe(500);
  });

  it('settles an async rejecting handler as 500 instead of hanging (#1378)', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.get('/async-fail', async () => {
      await Promise.resolve();
      throw new Error('async fail');
    });

    // Race against a timeout: a hung (never-settling) response would lose the
    // race. The fix must let the dispatch promise settle to a 500.
    const result = await Promise.race([
      dispatch(new Request(`${BASE}/api/v1/async-fail`)).then((r) => r.status),
      new Promise<'TIMEOUT'>((resolve) =>
        setTimeout(() => resolve('TIMEOUT'), 1000),
      ),
    ]);
    expect(result).toBe(500);
  });

  it('500s an async handler that resolves without responding (#1378)', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    // Handler completes but never calls res.json/send/end.
    server.get('/no-response', async () => {
      await Promise.resolve();
    });

    const result = await Promise.race([
      dispatch(new Request(`${BASE}/api/v1/no-response`)).then((r) => r.status),
      new Promise<'TIMEOUT'>((resolve) =>
        setTimeout(() => resolve('TIMEOUT'), 1000),
      ),
    ]);
    expect(result).toBe(500);
  });

  it('awaits a slow async handler that eventually responds', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.post('/slow', async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      res.status(202).json({ queued: true });
    });

    const res = await dispatch(
      new Request(`${BASE}/api/v1/slow`, { method: 'POST' }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
  });
});

describe('request body parsing (#1378)', () => {
  it('returns 400 (not 500) for a malformed JSON body', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute('POST', '/echo', async (req) => {
      const data = await req.json();
      return new Response(JSON.stringify(data));
    });

    const res = await dispatch(
      new Request(`${BASE}/api/v1/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not: valid json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('treats an empty JSON body as no body (handler runs, body undefined)', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute('POST', '/maybe', async (req) => {
      return new Response(JSON.stringify({ hasBody: req.body !== undefined }), {
        headers: { 'content-type': 'application/json' },
      });
    });

    const res = await dispatch(
      new Request(`${BASE}/api/v1/maybe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasBody: false });
  });

  it('still parses a well-formed JSON body', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute('POST', '/echo', async (req) => {
      const data = await req.json();
      return new Response(JSON.stringify(data));
    });

    const res = await dispatch(
      new Request(`${BASE}/api/v1/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('CORS handling', () => {
  it('answers OPTIONS preflight with 204 and default headers', async () => {
    const { dispatch } = makeServer({ cors: true });
    const res = await dispatch(
      new Request(`${BASE}/api/v1/anything`, { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('adds default CORS headers to handled responses', async () => {
    const { server, dispatch } = makeServer({ cors: true });
    server.addRoute('GET', '/ping', async () => new Response('pong'));

    const res = await dispatch(new Request(`${BASE}/api/v1/ping`));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('honors a custom CORS origin/methods/headers config', async () => {
    const { server, dispatch } = makeServer({
      cors: {
        origin: ['https://a.test', 'https://b.test'],
        methods: ['GET', 'POST'],
        headers: ['X-Token'],
      },
    });
    server.addRoute('GET', '/ping', async () => new Response('pong'));

    const res = await dispatch(new Request(`${BASE}/api/v1/ping`));
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://a.test, https://b.test',
    );
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect(res.headers.get('access-control-allow-headers')).toBe('X-Token');
  });
});

describe('authentication', () => {
  it('rejects requests with no Authorization header as 401', async () => {
    const { server, dispatch } = makeServer({
      cors: false,
      auth: { type: 'bearer', verify: async () => true },
    });
    server.addRoute('GET', '/secure', async () => new Response('secret'));

    const res = await dispatch(new Request(`${BASE}/api/v1/secure`));
    expect(res.status).toBe(401);
  });

  it('accepts a bearer token verified by the verify callback', async () => {
    const { server, dispatch } = makeServer({
      cors: false,
      auth: {
        type: 'bearer',
        verify: async (token) => token === 'good-token',
      },
    });
    server.addRoute('GET', '/secure', async () => new Response('secret'));

    const ok = await dispatch(
      new Request(`${BASE}/api/v1/secure`, {
        headers: { authorization: 'Bearer good-token' },
      }),
    );
    expect(ok.status).toBe(200);

    const bad = await dispatch(
      new Request(`${BASE}/api/v1/secure`, {
        headers: { authorization: 'Bearer wrong' },
      }),
    );
    expect(bad.status).toBe(401);
  });

  it.each([
    'bearer',
    'basic',
    'custom',
  ] as const)('refuses to construct with auth type %s and no verify', (type) => {
    expect(() =>
      createSmrtServer({
        auth: { type } as unknown as SmrtServerOptions['auth'],
      }),
    ).toThrow(SmrtServerConfigError);
    expect(() =>
      createSmrtServer({
        auth: { type } as unknown as SmrtServerOptions['auth'],
      }),
    ).toThrow(/requires an auth\.verify function/);
  });

  it.each([
    ['null', null],
    ['false', false],
    ['0', 0],
    ['an empty string', ''],
    ['a string', 'bearer'],
    ['an array', []],
  ] as const)('refuses to construct when auth is %s', (_label, value) => {
    expect(() =>
      createSmrtServer({
        auth: value as unknown as SmrtServerOptions['auth'],
      }),
    ).toThrow(SmrtServerConfigError);
  });

  it('treats an explicitly undefined auth as omitted', async () => {
    const { server, dispatch } = makeServer({ cors: false, auth: undefined });
    server.addRoute('GET', '/open', async () => new Response('ok'));
    const res = await dispatch(new Request(`${BASE}/api/v1/open`));
    expect(res.status).toBe(200);
  });

  it('runs without authentication when auth is omitted (documented open mode)', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute('GET', '/open', async () => new Response('ok'));
    const res = await dispatch(new Request(`${BASE}/api/v1/open`));
    expect(res.status).toBe(200);
  });

  it('rejects a bearer request whose scheme is missing or wrong without calling verify', async () => {
    const verify = vi.fn(async () => true);
    const { server, dispatch } = makeServer({
      cors: false,
      auth: { type: 'bearer', verify },
    });
    server.addRoute('GET', '/secure', async () => new Response('secret'));

    for (const header of [
      'good-token',
      'Basic good-token',
      'Bearer',
      'Bearer ',
    ]) {
      const res = await dispatch(
        new Request(`${BASE}/api/v1/secure`, {
          headers: { authorization: header },
        }),
      );
      expect(res.status, header).toBe(401);
    }
    expect(verify).not.toHaveBeenCalled();

    const ok = await dispatch(
      new Request(`${BASE}/api/v1/secure`, {
        headers: { authorization: 'bearer tok' },
      }),
    );
    expect(ok.status).toBe(200);
    expect(verify).toHaveBeenCalledWith('tok');
  });

  it('verifies basic credentials via the verify callback', async () => {
    const { server, dispatch } = makeServer({
      cors: false,
      auth: {
        type: 'basic',
        verify: async (creds) => creds === 'dXNlcjpwYXNz',
      },
    });
    server.addRoute('GET', '/secure', async () => new Response('secret'));

    const res = await dispatch(
      new Request(`${BASE}/api/v1/secure`, {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('verifies a custom auth header via the verify callback', async () => {
    const { server, dispatch } = makeServer({
      cors: false,
      auth: {
        type: 'custom',
        verify: async (header) => header === 'magic',
      },
    });
    server.addRoute('GET', '/secure', async () => new Response('secret'));

    const res = await dispatch(
      new Request(`${BASE}/api/v1/secure`, {
        headers: { authorization: 'magic' },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('basePath handling', () => {
  it('strips a custom basePath before route matching', async () => {
    const { server, dispatch } = makeServer({
      cors: false,
      basePath: '/custom',
    });
    server.addRoute('GET', '/ping', async () => new Response('pong'));

    const res = await dispatch(new Request(`${BASE}/custom/ping`));
    expect(await res.text()).toBe('pong');
  });
});

describe('request body limit', () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request(`${BASE}/api/v1/echo`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...headers },
      body,
    });

  it('answers 413 before authentication when the declared length is over the limit', async () => {
    const verify = vi.fn(async () => true);
    const { server, dispatch } = makeServer({
      cors: false,
      maxBodyBytes: 8,
      auth: { type: 'bearer', verify },
    });
    server.addRoute('POST', '/echo', async () => new Response('ok'));
    const res = await dispatch(
      post('x'.repeat(64), { 'content-length': '64' }),
    );
    expect(res.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
  });

  it('answers 401 for an unauthenticated body within the limit', async () => {
    const { server, dispatch } = makeServer({
      cors: false,
      auth: { type: 'bearer', verify: async () => true },
    });
    server.addRoute('POST', '/echo', async () => new Response('ok'));
    const res = await dispatch(post('hello'));
    expect(res.status).toBe(401);
  });

  const overLimitStream = () =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(32));
      },
    });

  it.each([
    ['an undeclared length', {}],
    ['an understated length', { 'content-length': '4' }],
  ])('answers 413 before verify runs for an over-limit body with %s', async (_label, headers) => {
    const verify = vi.fn(async () => false);
    const { server, dispatch } = makeServer({
      cors: false,
      maxBodyBytes: 8,
      auth: { type: 'bearer', verify },
    });
    server.addRoute('POST', '/echo', async () => new Response('ok'));
    const res = await dispatch(
      new Request(`${BASE}/api/v1/echo`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok', ...headers },
        body: overLimitStream(),
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
  });

  it('applies the limit to a streamed DELETE body before the handler runs', async () => {
    const handler = vi.fn(async () => new Response('ok'));
    const { server, dispatch } = makeServer({ cors: false, maxBodyBytes: 8 });
    server.addRoute('DELETE', '/echo', handler);
    const res = await dispatch(
      new Request(`${BASE}/api/v1/echo`, {
        method: 'DELETE',
        body: overLimitStream(),
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 413 to a CORS preflight that declares an over-limit body', async () => {
    const { dispatch } = makeServer({ cors: true, maxBodyBytes: 8 });
    const res = await dispatch(
      new Request(`${BASE}/api/v1/echo`, {
        method: 'OPTIONS',
        headers: { 'content-length': '64' },
      }),
    );
    expect(res.status).toBe(413);
    const ok = await dispatch(
      new Request(`${BASE}/api/v1/echo`, { method: 'OPTIONS' }),
    );
    expect(ok.status).toBe(204);
  });

  it('stops reading an undeclared-length body once the limit is crossed', async () => {
    const { server, dispatch } = makeServer({ cors: false, maxBodyBytes: 8 });
    server.addRoute('POST', '/echo', async () => new Response('ok'));
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4));
        if (pulled > 1000) controller.close();
      },
    });
    const res = await dispatch(
      new Request(`${BASE}/api/v1/echo`, {
        method: 'POST',
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(20);
  });

  it('decodes a BOM-prefixed JSON body the way Request.text() does', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute('POST', '/echo', async (req) => Response.json(req.body));
    const res = await dispatch(
      new Request(`${BASE}/api/v1/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('{"a":1}')]),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('counts the bytes received on the HTTP path, not re-encoded text', async () => {
    const server = createSmrtServer({ port: 0, maxBodyBytes: 16, cors: false });
    server.addRoute(
      'POST',
      '/echo',
      async (req) => new Response(String(req.body).length.toString()),
    );
    const { server: http } = await server.start();
    await new Promise((r) => http.once('listening', r));
    const addr = http.address() as { port: number };
    try {
      // 12 wire bytes; each invalid byte decodes to a 3-byte U+FFFD.
      const res = await fetch(`http://localhost:${addr.port}/api/v1/echo`, {
        method: 'POST',
        body: new Uint8Array(12).fill(0xff),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('12');
      const bom = await fetch(`http://localhost:${addr.port}/api/v1/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('"abc"')]),
      });
      expect(bom.status).toBe(200);
      expect(await bom.text()).toBe('3');
    } finally {
      http.close();
    }
  });

  it('writes the 413 response for a chunked upload still in progress on the HTTP path', async () => {
    const { request } = await import('node:http');
    const server = createSmrtServer({ port: 0, maxBodyBytes: 16, cors: false });
    const handler = vi.fn(async () => new Response('ok'));
    server.addRoute('POST', '/echo', handler);
    const { server: http } = await server.start();
    await new Promise((r) => http.once('listening', r));
    const addr = http.address() as { port: number };
    try {
      const outcome = await new Promise<{ status?: number; body?: string }>(
        (resolve, reject) => {
          const req = request({
            host: 'localhost',
            port: addr.port,
            method: 'POST',
            path: '/api/v1/echo',
            headers: { 'transfer-encoding': 'chunked' },
          });
          req.on('response', (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode, body }));
            res.on('error', reject);
          });
          req.on('error', reject);
          // Cross the limit part-way through, keep sending, and never finish
          // the upload.
          req.write('x'.repeat(8));
          const timer = setInterval(() => {
            if (req.destroyed) clearInterval(timer);
            else req.write('x'.repeat(4096));
          }, 5);
          req.on('close', () => clearInterval(timer));
        },
      );
      expect(outcome).toEqual({ status: 413, body: 'Payload Too Large' });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      http.closeAllConnections();
      http.close();
    }
  });

  it('authenticates a declared-length request on the HTTP path before reading its body', async () => {
    const net = await import('node:net');
    const verify = vi.fn(async () => false);
    const server = createSmrtServer({
      port: 0,
      cors: false,
      auth: { type: 'bearer', verify },
    });
    const handler = vi.fn(async () => new Response('ok'));
    server.addRoute('POST', '/echo', handler);
    const { server: http } = await server.start();
    await new Promise((r) => http.once('listening', r));
    const addr = http.address() as { port: number };
    try {
      // Headers only: the declared body is never sent, so a server that read
      // the body before authenticating would not answer.
      const head = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(addr.port, 'localhost');
        let data = '';
        const timer = setTimeout(() => {
          socket.destroy();
          resolve('timed out');
        }, 1000);
        socket.setEncoding('utf-8');
        socket.on('data', (chunk) => {
          data += chunk;
          if (data.includes('\r\n')) {
            clearTimeout(timer);
            socket.destroy();
            resolve(data.split('\r\n')[0]);
          }
        });
        socket.on('error', reject);
        socket.write(
          'POST /api/v1/echo HTTP/1.1\r\nHost: localhost\r\n' +
            'Authorization: Bearer tok\r\nContent-Length: 100\r\n\r\n',
        );
      });
      expect(head).toBe('HTTP/1.1 401 Unauthorized');
      expect(verify).toHaveBeenCalledWith('tok');
      expect(handler).not.toHaveBeenCalled();
    } finally {
      http.closeAllConnections();
      http.close();
    }
  });

  it('answers 413, not 401, to an unauthenticated chunked overrun on the HTTP path', async () => {
    const verify = vi.fn(async () => false);
    const server = createSmrtServer({
      port: 0,
      cors: false,
      maxBodyBytes: 16,
      auth: { type: 'bearer', verify },
    });
    server.addRoute('POST', '/echo', async () => new Response('ok'));
    const { server: http } = await server.start();
    await new Promise((r) => http.once('listening', r));
    const addr = http.address() as { port: number };
    try {
      const res = await fetch(`http://localhost:${addr.port}/api/v1/echo`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(64));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit);
      expect(res.status).toBe(413);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      http.closeAllConnections();
      http.close();
    }
  });

  it('answers 413 without waiting for the body stream to finish cancelling', async () => {
    const { server, dispatch } = makeServer({ cors: false, maxBodyBytes: 8 });
    server.addRoute('POST', '/echo', async () => new Response('ok'));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(16));
      },
      // A source whose cancellation never settles.
      cancel: () => new Promise<void>(() => undefined),
    });
    const pending = dispatch(
      new Request(`${BASE}/api/v1/echo`, {
        method: 'POST',
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    const outcome = await Promise.race([
      pending.then((res) => res.status),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 1000)),
    ]);
    expect(outcome).toBe(413);
  });

  it('accepts a body within the limit (default 1 MiB)', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    server.addRoute(
      'POST',
      '/echo',
      async (req) => new Response(String(req.body)),
    );
    const res = await dispatch(post('x'.repeat(1024)));
    expect(res.status).toBe(200);
    expect(await res.text()).toHaveLength(1024);
  });

  it('applies the 413 limit on the real HTTP path', async () => {
    const server = createSmrtServer({ port: 0, maxBodyBytes: 16, cors: false });
    server.addRoute('POST', '/echo', async () => new Response('ok'));
    const { server: http, url } = await server.start();
    await new Promise((r) => http.once('listening', r));
    const addr = http.address() as { port: number };
    try {
      const res = await fetch(`http://localhost:${addr.port}/api/v1/echo`, {
        method: 'POST',
        body: 'x'.repeat(1024),
      });
      expect(res.status).toBe(413);
      void url;
    } finally {
      http.close();
    }
  });
});

describe('request ingress bounds', () => {
  const nextTurn = () => new Promise<void>((r) => setImmediate(r));

  // A producer that overwrites each chunk's bytes once the reader has asked
  // for the next one (so the previous chunk has been consumed). Chunks that
  // were copied into server-owned storage are unaffected; a reader that kept
  // a reference to a chunk instead of copying it would see the overwrite.
  const scribblingBody = (parts: string[]) => {
    let pulls = 0;
    let previous: Uint8Array | undefined;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          previous?.fill(0x7a); // 'z'
          if (pulls < parts.length) {
            const bytes = Buffer.from(parts[pulls++]);
            previous = bytes;
            controller.enqueue(bytes);
            return;
          }
          previous = undefined;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
  };
  const post = (body: ReadableStream<Uint8Array>) =>
    new Request(`${BASE}/api/v1/echo`, {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);

  it('hands the route the bytes as received, not views of the producer buffers', async () => {
    const { server, dispatch } = makeServer({ cors: false, maxBodyBytes: 64 });
    server.addRoute(
      'POST',
      '/echo',
      async (req) => new Response(String(req.body)),
    );
    const res = await dispatch(
      post(scribblingBody(['ab', '', 'cd', '', '', 'ef'])),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abcdef');
  });

  it('keeps the original bytes across storage growth up to the cap, and refuses one byte more', async () => {
    const cap = 100 * 1024;
    const chunk = (n: number) =>
      String.fromCharCode(97 + (n % 26)).repeat(1024);
    const parts = Array.from({ length: 100 }, (_, n) => chunk(n));
    const handler = vi.fn(async (req: { body?: unknown }) => {
      return new Response(String(req.body));
    });
    const { server, dispatch } = makeServer({ cors: false, maxBodyBytes: cap });
    server.addRoute('POST', '/echo', handler);

    const ok = await dispatch(post(scribblingBody(parts)));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(parts.join(''));

    handler.mockClear();
    const over = await dispatch(post(scribblingBody([...parts, 'x'])));
    expect(over.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a single chunk larger than the cap without handing anything to the route', async () => {
    const handler = vi.fn(async () => new Response('ok'));
    const { server, dispatch } = makeServer({ cors: false, maxBodyBytes: 8 });
    server.addRoute('POST', '/echo', handler);
    const res = await dispatch(post(scribblingBody(['0123456789'])));
    expect(res.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts many empty chunks without growing the body', async () => {
    const { server, dispatch } = makeServer({ cors: false, maxBodyBytes: 4 });
    server.addRoute(
      'POST',
      '/echo',
      async (req) => new Response(String(req.body)),
    );
    const parts = [...Array.from({ length: 500 }, () => ''), 'ab'];
    const res = await dispatch(post(scribblingBody(parts)));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ab');
  });

  describe('client disconnect on the node listener', () => {
    // Observe the host-visible outcome: the listener's response is ended, the
    // route never ran, nothing was logged as a request error.
    const startObserved = async (
      options: SmrtServerOptions,
      onRequest?: (req: IncomingMessage) => void,
    ) => {
      const server = createSmrtServer({ port: 0, cors: false, ...options });
      const handler = vi.fn(async () => new Response('ok'));
      server.addRoute('POST', '/echo', handler);
      const { server: http } = await server.start();
      await new Promise((r) => http.once('listening', r));
      const ended = new Promise<number>((resolve) => {
        http.prependListener('request', (req, res) => {
          onRequest?.(req);
          const end = res.end.bind(res) as (...args: unknown[]) => unknown;
          (res as { end: unknown }).end = (...args: unknown[]) => {
            resolve(res.statusCode);
            return end(...args);
          };
        });
      });
      const closed = new Promise<void>((resolve) => {
        http.once('connection', (socket) =>
          socket.once('close', () => resolve()),
        );
      });
      const { port } = http.address() as { port: number };
      return { http, port, handler, ended, closed };
    };
    const settleOrTimeout = <T>(p: Promise<T>) =>
      Promise.race([
        p,
        new Promise<'pending'>((r) => setTimeout(() => r('pending'), 2000)),
      ]);
    const requestErrors = () =>
      loggerError.mock.calls.filter(
        (call) => call[0] === '[smrt] Request error',
      );

    it('ends quietly when the client leaves before the body read starts', async () => {
      loggerError.mockClear();
      const net = await import('node:net');
      let allow: ((ok: boolean) => void) | undefined;
      let inVerify: (() => void) | undefined;
      const verifying = new Promise<void>((r) => {
        inVerify = r;
      });
      const { http, port, handler, ended, closed } = await startObserved({
        auth: {
          type: 'bearer',
          verify: () =>
            new Promise<boolean>((resolve) => {
              allow = resolve;
              inVerify?.();
            }),
        },
      });
      try {
        const socket = net.connect(port, 'localhost');
        socket.on('error', () => undefined);
        socket.write(
          'POST /api/v1/echo HTTP/1.1\r\nHost: localhost\r\n' +
            'Authorization: Bearer tok\r\nContent-Length: 100\r\n\r\n',
        );
        await verifying;
        socket.destroy();
        await closed;
        await nextTurn();
        allow?.(true);

        expect(await settleOrTimeout(ended)).not.toBe('pending');
        expect(handler).not.toHaveBeenCalled();
        expect(requestErrors()).toEqual([]);
      } finally {
        http.closeAllConnections();
        http.close();
      }
    });

    it('ends quietly when the connection closes without end while the body is being read', async () => {
      loggerError.mockClear();
      const net = await import('node:net');
      const verify = vi.fn(async () => true);
      const { http, port, handler, ended, closed } = await startObserved({
        auth: { type: 'bearer', verify },
      });
      try {
        const socket = net.connect(port, 'localhost');
        socket.on('error', () => undefined);
        // Chunked: nothing is authenticated until the body has been read.
        socket.write(
          'POST /api/v1/echo HTTP/1.1\r\nHost: localhost\r\n' +
            'Authorization: Bearer tok\r\nTransfer-Encoding: chunked\r\n\r\n' +
            '5\r\nhello\r\n',
        );
        await new Promise((r) => setTimeout(r, 50));
        socket.destroy();
        await closed;

        expect(await settleOrTimeout(ended)).not.toBe('pending');
        expect(handler).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
        expect(requestErrors()).toEqual([]);
      } finally {
        http.closeAllConnections();
        http.close();
      }
    });

    it('still answers 500 and logs for an unrelated request stream failure', async () => {
      loggerError.mockClear();
      const { http, port, handler } = await startObserved({}, (req) =>
        req.destroy(new Error('unrelated stream failure')),
      );
      try {
        const res = await fetch(`http://localhost:${port}/api/v1/echo`, {
          method: 'POST',
          body: 'hello',
        }).catch(() => undefined);
        // The request stream is destroyed by the host, so the socket may drop
        // before a status arrives; the log line is the stable observation.
        void res;
        await new Promise((r) => setTimeout(r, 100));
        expect(handler).not.toHaveBeenCalled();
        expect(requestErrors()).toHaveLength(1);
      } finally {
        http.closeAllConnections();
        http.close();
      }
    });
  });

  it('answers 413 to a declared Content-Length beyond the numeric range', async () => {
    const verify = vi.fn(async () => true);
    const { server, dispatch } = makeServer({
      cors: false,
      maxBodyBytes: 8,
      auth: { type: 'bearer', verify },
    });
    const handler = vi.fn(async () => new Response('ok'));
    server.addRoute('POST', '/echo', handler);
    const res = await dispatch(
      new Request(`${BASE}/api/v1/echo`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok',
          'content-length': '9'.repeat(400),
        },
        body: 'x',
      }),
    );
    expect(res.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 400 to a Content-Length that is not a decimal length', async () => {
    const { server, dispatch } = makeServer({ cors: false });
    const handler = vi.fn(async () => new Response('ok'));
    server.addRoute('POST', '/echo', handler);
    for (const declared of ['abc', '1e3', '-1', '0x10', '1.5']) {
      const res = await dispatch(
        new Request(`${BASE}/api/v1/echo`, {
          method: 'POST',
          headers: { 'content-length': declared },
          body: 'x',
        }),
      );
      expect(res.status, declared).toBe(400);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts a declared Content-Length at the limit, with leading zeros', async () => {
    const { server, dispatch } = makeServer({ cors: false, maxBodyBytes: 8 });
    server.addRoute(
      'POST',
      '/echo',
      async (req) => new Response(String(req.body)),
    );
    for (const declared of ['8', '00000000000000000000008', '1']) {
      const res = await dispatch(
        new Request(`${BASE}/api/v1/echo`, {
          method: 'POST',
          headers: { 'content-length': declared },
          body: 'x',
        }),
      );
      expect(res.status, declared).toBe(200);
    }
    const over = await dispatch(
      new Request(`${BASE}/api/v1/echo`, {
        method: 'POST',
        headers: { 'content-length': '0000000009' },
        body: 'x',
      }),
    );
    expect(over.status).toBe(413);
  });

  it('gives a request without Content-Type the text/plain default on the HTTP path', async () => {
    const { request } = await import('node:http');
    const server = createSmrtServer({ port: 0, cors: false });
    const seen: Array<{ method: string; type: string | undefined }> = [];
    const record = async (req: {
      method: string;
      headers: Record<string, string>;
      body?: unknown;
    }) => {
      seen.push({ method: req.method, type: req.headers['content-type'] });
      return new Response(String(req.body ?? ''));
    };
    server.addRoute('POST', '/echo', record);
    server.addRoute('DELETE', '/echo', record);
    server.addRoute('GET', '/echo', record);
    const { server: http } = await server.start();
    await new Promise((r) => http.once('listening', r));
    const addr = http.address() as { port: number };
    const send = (
      method: string,
      body: string | undefined,
      headers: Record<string, string> = {},
    ) =>
      new Promise<string>((resolve, reject) => {
        const req = request({
          host: 'localhost',
          port: addr.port,
          method,
          path: '/api/v1/echo',
          headers,
        });
        req.on('response', (res) => {
          let text = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve(text));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
      });
    try {
      expect(await send('POST', 'hi')).toBe('hi');
      expect(await send('DELETE', undefined)).toBe('');
      expect(
        await send('POST', '{"a":1}', { 'content-type': 'application/json' }),
      ).toBe('[object Object]');
      expect(await send('GET', undefined)).toBe('');
      expect(seen).toEqual([
        { method: 'POST', type: 'text/plain;charset=UTF-8' },
        { method: 'DELETE', type: 'text/plain;charset=UTF-8' },
        { method: 'POST', type: 'application/json' },
        { method: 'GET', type: undefined },
      ]);
    } finally {
      http.closeAllConnections();
      http.close();
    }
  });
});
