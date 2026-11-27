import { afterEach, describe, expect, it, vi } from 'vitest';
import { meterRequest, setRequestMeterSink } from './request-metering';
import { APIGenerator } from './rest';
import {
  configureRouteLimits,
  enforceRouteLimits,
  type RouteLimitSubject,
} from './route-limits';

const subject = (over: Partial<RouteLimitSubject> = {}): RouteLimitSubject => ({
  request: new Request('http://local/api/things'),
  tenantId: 't1',
  userId: 'u1',
  authenticated: true,
  ...over,
});

afterEach(() => {
  setRequestMeterSink(undefined);
  configureRouteLimits(undefined);
});

describe('request metering (#5199)', () => {
  it('reports the decided principal, with no limiter configured', () => {
    const sink = vi.fn();
    setRequestMeterSink(sink);
    expect(
      enforceRouteLimits(subject({ callerKind: 'guest' })),
    ).toBeUndefined();
    expect(sink).toHaveBeenCalledWith({
      tenantId: 't1',
      callerKind: 'guest',
      authenticated: true,
      limited: false,
      transport: 'sveltekit',
    });
  });

  it('flags a request the limits refused', () => {
    const sink = vi.fn();
    setRequestMeterSink(sink);
    configureRouteLimits({ client: { maxEvents: 1, windowMs: 60_000 } });
    enforceRouteLimits(subject());
    expect(enforceRouteLimits(subject())?.status).toBe(429);
    expect(sink.mock.calls.map(([e]) => e.limited)).toEqual([false, true]);
  });

  it('reports a caller with no tenant or kind as null', () => {
    const sink = vi.fn();
    enforceRouteLimits(
      subject({ tenantId: undefined, userId: null, authenticated: false }),
      undefined,
      sink,
    );
    expect(sink).toHaveBeenCalledWith({
      tenantId: null,
      callerKind: null,
      authenticated: false,
      limited: false,
      transport: 'sveltekit',
    });
  });

  it('never throws into the request: a throwing or rejecting sink is swallowed', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    expect(() =>
      meterRequest(
        {
          tenantId: null,
          callerKind: null,
          authenticated: false,
          limited: false,
          transport: 'rest',
        },
        () => {
          throw new Error('boom');
        },
      ),
    ).not.toThrow();
    enforceRouteLimits(subject(), undefined, async () => {
      throw new Error('async boom');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('counts a REST request once under the resolved tenant, not a header', async () => {
    const sink = vi.fn();
    const handler = new APIGenerator(
      {
        basePath: '/api',
        requestMeter: sink,
        resolvePrincipal: () => ({
          tenantId: 't1',
          allowCrossTenant: false,
          authenticated: true,
          userId: 'u1',
          callerKind: 'agent',
        }),
      },
      { db: { query: vi.fn() } as never },
    ).generateHandler();
    await handler(
      new Request('http://local/api/nothing?tenantId=evil', {
        headers: { 'x-tenant-id': 'evil', 'x-caller-kind': 'owner' },
      }),
    );
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({
      tenantId: 't1',
      callerKind: 'agent',
      authenticated: true,
      limited: false,
      transport: 'rest',
    });
  });

  it('attributes a resolveTenant host to its tenant with no limiter, and does not resolve with no meter', async () => {
    const sink = vi.fn();
    const resolveTenant = vi.fn(() => ({
      tenantId: 't9',
      authenticated: true,
    }));
    const config = {
      basePath: '/api',
      resolveTenant,
      customRoutes: { '/ping': async () => new Response('pong') },
    };
    const metered = new APIGenerator(
      { ...config, requestMeter: sink },
      { db: { query: vi.fn() } as never },
    ).generateHandler();
    await metered(new Request('http://local/api/ping'));
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't9', limited: false }),
    );
    resolveTenant.mockClear();
    const bare = new APIGenerator(config, {
      db: { query: vi.fn() } as never,
    }).generateHandler();
    await bare(new Request('http://local/api/ping'));
    expect(resolveTenant).not.toHaveBeenCalled();
  });
});
