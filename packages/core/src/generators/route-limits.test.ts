import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIGenerator } from './rest';
import {
  configureRouteLimits,
  createRouteLimiter,
  enforceRouteLimits,
  getRouteLimiter,
  type RouteLimitSubject,
} from './route-limits';

const request = (headers: Record<string, string> = {}) =>
  new Request('http://local/api/things', { headers });

const subject = (over: Partial<RouteLimitSubject> = {}): RouteLimitSubject => ({
  request: request(),
  tenantId: 't1',
  userId: 'u1',
  ...over,
});

const WINDOW = { windowMs: 60_000 };

afterEach(() => configureRouteLimits(undefined));

describe('createRouteLimiter (#5198)', () => {
  it('admits up to maxEvents then refuses with Retry-After seconds', () => {
    const limiter = createRouteLimiter({ client: { maxEvents: 2, ...WINDOW } });
    expect(limiter.admit(subject(), 0)).toBeNull();
    expect(limiter.admit(subject(), 1)).toBeNull();
    expect(limiter.admit(subject(), 2)).toEqual({ retryAfterSeconds: 60 });
    expect(limiter.admit(subject(), 60_001)).toBeNull();
  });

  it('does not count a refused request', () => {
    const limiter = createRouteLimiter({ client: { maxEvents: 1, ...WINDOW } });
    limiter.admit(subject(), 0);
    for (let i = 1; i < 50; i++) limiter.admit(subject(), i);
    // The window ends 60s after the one admitted request, not the last refusal.
    expect(limiter.admit(subject(), 60_000)).toBeNull();
  });

  it('keys per tenant and per caller', () => {
    const limiter = createRouteLimiter({ client: { maxEvents: 1, ...WINDOW } });
    expect(limiter.admit(subject(), 0)).toBeNull();
    expect(limiter.admit(subject({ userId: 'u2' }), 0)).toBeNull();
    expect(limiter.admit(subject({ tenantId: 't2' }), 0)).toBeNull();
    expect(limiter.admit(subject(), 1)).not.toBeNull();
  });

  it('applies the tenant-wide limit across callers', () => {
    const limiter = createRouteLimiter({
      client: { maxEvents: 5, ...WINDOW },
      tenant: { maxEvents: 2, ...WINDOW },
    });
    expect(limiter.admit(subject({ userId: 'a' }), 0)).toBeNull();
    expect(limiter.admit(subject({ userId: 'b' }), 0)).toBeNull();
    expect(limiter.admit(subject({ userId: 'c' }), 0)).not.toBeNull();
    expect(
      limiter.admit(subject({ userId: 'c', tenantId: 't2' }), 0),
    ).toBeNull();
  });

  it('scales any caller kind by its table entry, a guest by default', () => {
    const limiter = createRouteLimiter({
      client: { maxEvents: 8, ...WINDOW },
      callerKindScale: { agent: 0.5 },
    });
    const run = (callerKind: string) => {
      let admitted = 0;
      for (let i = 0; i < 20; i++) {
        if (
          limiter.admit(subject({ callerKind, userId: callerKind }), i) === null
        ) {
          admitted++;
        }
      }
      return admitted;
    };
    expect(run('guest')).toBe(2);
    expect(run('agent')).toBe(4);
    expect(run('user')).toBe(8);
    // `Object.prototype` names are not kinds.
    expect(run('constructor')).toBe(8);
  });

  it('keys an unsigned caller by client IP, trusting only configured hops', () => {
    const spoof = (n: number) =>
      subject({
        userId: null,
        request: request({ 'x-forwarded-for': `9.9.9.${n}, 1.1.1.1` }),
      });
    const ignored = createRouteLimiter({ client: { maxEvents: 1, ...WINDOW } });
    expect(ignored.admit(spoof(1), 0)).toBeNull();
    // Varying the header does not buy a fresh bucket.
    expect(ignored.admit(spoof(2), 0)).not.toBeNull();

    const trusted = createRouteLimiter({
      client: { maxEvents: 1, ...WINDOW },
      trustProxyHops: 1,
    });
    expect(trusted.admit(spoof(1), 0)).toBeNull();
    expect(trusted.admit(spoof(2), 0)).not.toBeNull();
    const other = subject({
      userId: null,
      request: request({ 'x-forwarded-for': '9.9.9.1, 2.2.2.2' }),
    });
    expect(trusted.admit(other, 0)).toBeNull();
  });

  it('keys an unsigned caller by the transport peer address', () => {
    const limiter = createRouteLimiter({ client: { maxEvents: 1, ...WINDOW } });
    const from = (clientAddress: string) =>
      subject({ userId: null, clientAddress });
    expect(limiter.admit(from('10.0.0.1'), 0)).toBeNull();
    expect(limiter.admit(from('10.0.0.2'), 0)).toBeNull();
    expect(limiter.admit(from('10.0.0.1'), 1)).not.toBeNull();
    // A configured resolver wins over the transport's address.
    const resolved = createRouteLimiter({
      client: { maxEvents: 1, ...WINDOW },
      clientAddress: () => 'fixed',
    });
    expect(resolved.admit(from('10.0.0.1'), 0)).toBeNull();
    expect(resolved.admit(from('10.0.0.2'), 0)).not.toBeNull();
  });

  it('rejects malformed limits', () => {
    expect(() =>
      createRouteLimiter({ client: { maxEvents: 0, ...WINDOW } }),
    ).toThrow(RangeError);
    expect(() =>
      createRouteLimiter({
        client: { maxEvents: 1, ...WINDOW },
        callerKindScale: { guest: 0 },
      }),
    ).toThrow(RangeError);
  });
});

describe('enforceRouteLimits', () => {
  it('is a no-op with no limiter and fails open on a limiter defect', () => {
    expect(enforceRouteLimits(subject())).toBeUndefined();
    const broken = {
      admit: () => {
        throw new Error('boom');
      },
      reset() {},
    };
    expect(enforceRouteLimits(subject(), broken)).toBeUndefined();
  });

  it('answers 429 with Retry-After and no store', async () => {
    configureRouteLimits({ client: { maxEvents: 1, ...WINDOW } });
    expect(enforceRouteLimits(subject())).toBeUndefined();
    const response = enforceRouteLimits(subject());
    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get('retry-after'))).toBeGreaterThanOrEqual(
      1,
    );
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.json()).toEqual({
      message: 'Too many requests.',
      code: 'too_many_requests',
    });
    expect(getRouteLimiter()).toBeDefined();
  });
});

describe('APIGenerator routeLimits', () => {
  it('counts a nested dispatch once, with the outer request', async () => {
    const handler: (req: Request) => Promise<Response> = new APIGenerator(
      {
        basePath: '/api',
        routeLimits: { client: { maxEvents: 2, ...WINDOW } },
        resolvePrincipal: () => ({
          tenantId: 't1',
          allowCrossTenant: false,
          authenticated: true,
          userId: 'u1',
        }),
        customRoutes: {
          '/outer': async (req: Request) =>
            // A nested dispatch from inside the request.
            handler(new Request(new URL('/api/nothing', req.url))),
        },
      },
      { db: { query: vi.fn() } as never },
    ).generateHandler();
    const first = await handler(new Request('http://local/api/outer'));
    expect(first.status).not.toBe(429);
    // One slot used, not two: the second request is still admitted.
    const second = await handler(new Request('http://local/api/outer'));
    expect(second.status).not.toBe(429);
    const third = await handler(new Request('http://local/api/outer'));
    expect(third.status).toBe(429);
  });

  it('refuses before onRequest, authorization or the database', async () => {
    const onRequest = vi.fn();
    const query = vi.fn();
    const handler = new APIGenerator(
      {
        basePath: '/api',
        routeLimits: { client: { maxEvents: 1, ...WINDOW } },
        resolvePrincipal: () => ({
          tenantId: 't1',
          allowCrossTenant: false,
          authenticated: true,
          userId: 'u1',
          callerKind: 'guest',
        }),
        onRequest,
      },
      { db: { query } as never },
    ).generateHandler();
    const first = await handler(new Request('http://local/api/nothing'));
    expect(first.status).not.toBe(429);
    expect(onRequest).toHaveBeenCalledTimes(1);
    const second = await handler(new Request('http://local/api/nothing'));
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });
});
