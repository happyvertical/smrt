/**
 * Tests for the SMRT runtime HTTP server (src/runtime/server.ts).
 *
 * The bulk of SmrtServer is request-routing logic that does not require a live
 * socket: route registration, :param matching, the Express-style response
 * adapter, CORS handling, and bearer/basic/custom auth. We drive these through
 * the server's request handler with synthetic Web `Request` objects so no port
 * is ever opened.
 *
 * The genuinely server-bound surface — start(), nodeRequestToWebRequest(),
 * webResponseToNodeResponse(), streamToString() — is NOT exercised here; it
 * requires spawning an http.Server and is flagged as infeasible for unit tests.
 */

import { describe, expect, it } from 'vitest';
import { createSmrtServer } from './index.js';
import type { SmrtServerOptions } from './types.js';

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
      auth: { type: 'bearer' },
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

  it('accepts a bearer token when no verify callback is configured', async () => {
    const { server, dispatch } = makeServer({
      cors: false,
      auth: { type: 'bearer' },
    });
    server.addRoute('GET', '/secure', async () => new Response('secret'));

    const res = await dispatch(
      new Request(`${BASE}/api/v1/secure`, {
        headers: { authorization: 'Bearer anything' },
      }),
    );
    expect(res.status).toBe(200);
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
