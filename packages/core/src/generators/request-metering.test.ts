import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  meterRequest,
  refusalOfStatus,
  setRequestMeterSink,
} from './request-metering';
import { APIGenerator } from './rest';
import { configureRouteLimits } from './route-limits';

afterEach(() => {
  setRequestMeterSink(undefined);
  configureRouteLimits(undefined);
});

const WINDOW = { windowMs: 60_000 };
const db = () => ({ db: { query: vi.fn() } as never });
const ping = { '/ping': async () => new Response('pong') };

/** A REST handler that resolves principals; `kind` 'none' is an anonymous caller. */
function restHandler(
  principal: 'user' | 'anonymous',
  extra: Record<string, unknown> = {},
) {
  const sink = vi.fn();
  const handler = new APIGenerator(
    {
      basePath: '/api',
      requestMeter: sink,
      customRoutes: ping,
      resolvePrincipal: () =>
        principal === 'user'
          ? {
              tenantId: 't1',
              allowCrossTenant: false,
              authenticated: true,
              userId: 'u1',
              callerKind: 'agent',
            }
          : { tenantId: null, allowCrossTenant: false, authenticated: false },
      ...extra,
    },
    db(),
  ).generateHandler();
  return { handler, sink };
}

describe('request metering (#5199)', () => {
  it('maps refusal statuses', () => {
    expect([200, 404, 401, 403, 429].map(refusalOfStatus)).toEqual([
      null,
      null,
      'unauthenticated',
      'forbidden',
      'rate_limited',
    ]);
  });

  it('counts a served request under its tenant with the limiter off', async () => {
    const { handler, sink } = restHandler('user');
    await handler(
      new Request('http://local/api/ping?tenantId=evil', {
        headers: { 'x-tenant-id': 'evil', 'x-caller-kind': 'owner' },
      }),
    );
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({
      tenantId: 't1',
      callerKind: 'agent',
      authenticated: true,
      limited: false,
      refused: null,
      transport: 'rest',
    });
  });

  it('counts a served request under its tenant with the limiter on', async () => {
    const { handler, sink } = restHandler('user', {
      routeLimits: { client: { maxEvents: 5, ...WINDOW } },
    });
    await handler(new Request('http://local/api/ping'));
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', refused: null }),
    );
  });

  it('counts a refused 429 under no tenant, with its reason', async () => {
    const { handler, sink } = restHandler('user', {
      routeLimits: { client: { maxEvents: 1, ...WINDOW } },
    });
    await handler(new Request('http://local/api/ping'));
    const second = await handler(new Request('http://local/api/ping'));
    expect(second.status).toBe(429);
    expect(sink.mock.calls.map(([e]) => [e.tenantId, e.refused])).toEqual([
      ['t1', null],
      [null, 'rate_limited'],
    ]);
    expect(sink.mock.calls[1][0].limited).toBe(true);
  });

  it('an anonymous request naming tenant B, refused, does not count against B', async () => {
    const { handler, sink } = restHandler('anonymous', {
      customRoutes: undefined,
      authMiddleware: undefined,
    });
    // A non-public model route refuses an unsigned caller (401); the request
    // names tenant B in every place a client can.
    const answer = await handler(
      new Request('http://local/api/anything?tenantId=B&tenant_id=B', {
        headers: { 'x-tenant-id': 'B' },
      }),
    );
    expect([401, 403, 404]).toContain(answer.status);
    const events = sink.mock.calls.map(([e]) => e);
    expect(events).toHaveLength(1);
    expect(events.some((e) => e.tenantId === 'B')).toBe(false);
    if (answer.status !== 404) {
      expect(events[0].tenantId).toBeNull();
      expect(events[0].refused).not.toBeNull();
    }
  });

  it('attributes a resolveTenant host to its tenant, limiter on or off', async () => {
    for (const routeLimits of [
      undefined,
      { client: { maxEvents: 5, ...WINDOW } },
    ]) {
      const sink = vi.fn();
      const handler = new APIGenerator(
        {
          basePath: '/api',
          requestMeter: sink,
          customRoutes: ping,
          resolveTenant: () => ({ tenantId: 't9', authenticated: true }),
          ...(routeLimits ? { routeLimits } : {}),
        },
        db(),
      ).generateHandler();
      await handler(new Request('http://local/api/ping'));
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't9', refused: null }),
      );
    }
  });

  it('does not look up resolveTenant with no limiter and no meter', async () => {
    const resolveTenant = vi.fn(() => ({ tenantId: 't9' }));
    const handler = new APIGenerator(
      { basePath: '/api', customRoutes: ping, resolveTenant },
      db(),
    ).generateHandler();
    await handler(new Request('http://local/api/ping'));
    expect(resolveTenant).not.toHaveBeenCalled();
  });

  it('never throws into the request: a throwing or rejecting sink is swallowed', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const event = {
      tenantId: null,
      callerKind: null,
      authenticated: false,
      limited: false,
      refused: null,
      transport: 'rest' as const,
    };
    expect(() =>
      meterRequest(event, () => {
        throw new Error('boom');
      }),
    ).not.toThrow();
    meterRequest(event, async () => {
      throw new Error('async boom');
    });
    for (const requestMeter of [
      () => {
        throw new Error('boom');
      },
      async () => {
        throw new Error('async boom');
      },
    ]) {
      const { handler } = restHandler('user', { requestMeter });
      expect((await handler(new Request('http://local/api/ping'))).status).toBe(
        200,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('counts a nested dispatch once, with the outer request', async () => {
    const sink = vi.fn();
    const handler: (req: Request) => Promise<Response> = new APIGenerator(
      {
        basePath: '/api',
        requestMeter: sink,
        resolvePrincipal: () => ({
          tenantId: 't1',
          allowCrossTenant: false,
          authenticated: true,
          userId: 'u1',
        }),
        customRoutes: {
          '/outer': async (req: Request) =>
            handler(new Request(new URL('/api/ping', req.url))),
          ...ping,
        },
      },
      db(),
    ).generateHandler();
    await handler(new Request('http://local/api/outer'));
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
