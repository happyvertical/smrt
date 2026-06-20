/**
 * Tests for the framework adapters (`src/adapters/*`): the CLI context runner,
 * the Express middleware, and the SvelteKit handle. These establish tenant
 * context from a request/invocation principal.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createCliContext, runAsSystem, runWithTenant } from '../adapters/cli';
import { createExpressMiddleware } from '../adapters/express';
// Import the barrel too so its re-exports are covered.
import * as adapters from '../adapters/index';
import { createSvelteKitHandle } from '../adapters/sveltekit';
import {
  getTenantId,
  isSuperAdminBypass,
  isSystemContext,
  withSystemContext,
} from '../context';

describe('adapters barrel', () => {
  it('re-exports the adapter factories', () => {
    expect(typeof adapters.createCliContext).toBe('function');
    expect(typeof adapters.createExpressMiddleware).toBe('function');
    expect(typeof adapters.createSvelteKitHandle).toBe('function');
  });
});

describe('createCliContext', () => {
  it('run() uses the resolved tenant', async () => {
    const cli = createCliContext({ resolveTenantId: () => 'tenant-x' });
    let observed: string | undefined;
    await cli.run(async () => {
      observed = getTenantId();
    });
    expect(observed).toBe('tenant-x');
  });

  it('run() falls back to system context when no tenant resolves', async () => {
    const cli = createCliContext({ resolveTenantId: () => null });
    let system = false;
    await cli.run(async () => {
      system = isSystemContext();
    });
    expect(system).toBe(true);
  });

  it('run() with no resolver at all falls back to system context', async () => {
    const cli = createCliContext();
    let system = false;
    await cli.run(async () => {
      system = isSystemContext();
    });
    expect(system).toBe(true);
  });

  it('runWithTenant() enters the given tenant and resolves the user id', async () => {
    const cli = createCliContext({ resolveUserId: async () => 'user-1' });
    let observed: string | undefined;
    const result = await cli.runWithTenant('tenant-y', async () => {
      observed = getTenantId();
      return 'done';
    });
    expect(observed).toBe('tenant-y');
    expect(result).toBe('done');
  });

  it('runAsSystem() runs without a tenant', async () => {
    const cli = createCliContext({ resolveTenantId: () => 'ignored' });
    let system = false;
    await cli.runAsSystem(async () => {
      system = isSystemContext();
    });
    expect(system).toBe(true);
  });

  it('runAsSuperAdmin() enters a tenant with the bypass flag', async () => {
    const cli = createCliContext({ superAdminByDefault: false });
    let bypass = false;
    let observed: string | undefined;
    await cli.runAsSuperAdmin('tenant-z', async () => {
      bypass = isSuperAdminBypass();
      observed = getTenantId();
    });
    expect(bypass).toBe(true);
    expect(observed).toBe('tenant-z');
  });

  it('standalone runWithTenant() / runAsSystem() helpers work', async () => {
    let observed: string | undefined;
    await runWithTenant('tenant-q', async () => {
      observed = getTenantId();
    });
    expect(observed).toBe('tenant-q');

    let system = false;
    await runAsSystem(async () => {
      system = isSystemContext();
    });
    expect(system).toBe(true);
  });
});

function makeExpressDoubles() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const calls: { next: unknown[] } = { next: [] };
  const next = (err?: unknown) => {
    calls.next.push(err);
  };
  return { res, next, calls };
}

describe('createExpressMiddleware', () => {
  it('skips excluded paths without resolving a tenant', async () => {
    const mw = createExpressMiddleware({
      resolveTenantId: () => {
        throw new Error('should not be called');
      },
      excludePaths: ['/health'],
    });
    const { res, next, calls } = makeExpressDoubles();
    await mw({ path: '/health' } as any, res as any, next as any);
    expect(calls.next).toHaveLength(1);
    expect(calls.next[0]).toBeUndefined();
  });

  it('responds 400 when no tenant is resolved and there is no onNoTenant hook', async () => {
    const mw = createExpressMiddleware({ resolveTenantId: () => null });
    const { res, next, calls } = makeExpressDoubles();
    await mw({ path: '/api' } as any, res as any, next as any);
    expect(res.statusCode).toBe(400);
    expect(calls.next).toHaveLength(0);
  });

  it('continues when onNoTenant returns true', async () => {
    const mw = createExpressMiddleware({
      resolveTenantId: () => null,
      onNoTenant: async () => true,
    });
    const { res, next, calls } = makeExpressDoubles();
    await mw({ path: '/api' } as any, res as any, next as any);
    expect(calls.next).toHaveLength(1);
  });

  it('establishes context on the request when a tenant resolves', async () => {
    const mw = createExpressMiddleware({
      resolveTenantId: () => 'tenant-a',
      resolveUserId: () => 'user-a',
      resolvePermissions: () => new Set(['read']),
      isSuperAdmin: () => true,
    });
    const { res, next, calls } = makeExpressDoubles();
    const req: any = { path: '/api' };
    // Run inside a scope so the middleware's enterWith() context is restored on
    // exit and does not leak into other tests.
    await withSystemContext(async () => {
      await mw(req, res as any, next as any);
    });
    expect(calls.next).toHaveLength(1);
    expect(req.tenantId).toBe('tenant-a');
    expect(req.tenantContext.tenantId).toBe('tenant-a');
    expect(req.tenantContext.superAdminBypass).toBe(true);
  });

  it('forwards resolver errors to next(err)', async () => {
    const boom = new Error('resolve failed');
    const mw = createExpressMiddleware({
      resolveTenantId: () => {
        throw boom;
      },
    });
    const { res, next, calls } = makeExpressDoubles();
    await mw({ path: '/api' } as any, res as any, next as any);
    expect(calls.next).toEqual([boom]);
  });
});

describe('createSvelteKitHandle', () => {
  const event = (pathname: string) => ({
    url: { pathname },
    locals: {} as Record<string, unknown>,
  });

  it('skips excluded paths', async () => {
    const handle = createSvelteKitHandle({
      resolveTenantId: () => {
        throw new Error('should not be called');
      },
      excludePaths: ['/public/*'],
    });
    const resolve = async () => 'resolved' as unknown as Response;
    const out = await handle({
      event: event('/public/page') as any,
      resolve: resolve as any,
    });
    expect(out).toBe('resolved');
  });

  it('resolves without context when no tenant and onNoTenant returns nothing', async () => {
    const handle = createSvelteKitHandle({
      resolveTenantId: () => null,
      onNoTenant: async () => undefined,
    });
    let resolvedTid: string | undefined = 'unset';
    const resolve = async () => {
      resolvedTid = getTenantId();
      return 'r' as unknown as Response;
    };
    await handle({ event: event('/x') as any, resolve: resolve as any });
    expect(resolvedTid).toBeUndefined();
  });

  it('returns the onNoTenant response when provided', async () => {
    const sentinel = 'short-circuit' as unknown as Response;
    const handle = createSvelteKitHandle({
      resolveTenantId: () => null,
      onNoTenant: async () => sentinel,
    });
    const out = await handle({
      event: event('/x') as any,
      resolve: (async () => 'nope' as unknown as Response) as any,
    });
    expect(out).toBe(sentinel);
  });

  it('runs resolve() inside the tenant context and stores it on locals', async () => {
    const handle = createSvelteKitHandle({
      resolveTenantId: () => 'tenant-b',
      resolveUserId: () => 'user-b',
      resolvePermissions: () => new Set(['write']),
    });
    const ev = event('/dash');
    let observed: string | undefined;
    const resolve = async () => {
      observed = getTenantId();
      return 'ok' as unknown as Response;
    };
    await handle({ event: ev as any, resolve: resolve as any });
    expect(observed).toBe('tenant-b');
    expect((ev.locals as any).tenantId).toBe('tenant-b');
  });

  afterEach(() => {
    // No global state to reset here, but keep the hook for symmetry/safety.
  });
});
