/**
 * Guest admission in the SvelteKit session step (#5196, slice G).
 *
 * The users session layer is replaced with a recorder (as in
 * sveltekit-rls.test.ts); the guest admitter itself is real, with its catalog
 * probe, ceiling tables and resolver supplied through the `guest` seam. The
 * live PostgreSQL proof lands with the on-demand workflow.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ResolvedApplicationRuntime,
  resolveApplicationRuntime,
  setConfig,
} from '@happyvertical/smrt-config';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import type { Handle } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuestCatalogPosture } from './sveltekit/guest.js';

const recorded = vi.hoisted(() => ({
  principalCalls: [] as Array<Record<string, unknown>>,
  sessionCalls: [] as Array<{ sessionId: string | null | undefined }>,
  verdict: 'none' as 'none' | 'valid' | 'rejected',
  principalRls: true,
  scope: undefined as unknown as AsyncLocalStorage<{ label: string }>,
}));
recorded.scope = new AsyncLocalStorage<{ label: string }>();

vi.mock('@happyvertical/smrt-users', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happyvertical/smrt-users')>();
  class RecordingSessionService {
    async initialize(): Promise<void> {}
    async loadSessionContext(): Promise<unknown> {
      if (recorded.verdict === 'none') return null;
      // `rejected`: a session in a tenant it has no membership in.
      const member = recorded.verdict === 'valid';
      return {
        sessionId: 'session-id',
        tenantId: member ? 'tenant-a' : 'foreign-tenant',
        user: { id: 'u1' },
        permissions: [],
        membership: member ? { id: 'm1', isActive: () => true } : null,
        tenantAuthorization: member
          ? { membershipId: 'm1', inheritedFromTenantId: null }
          : undefined,
      };
    }
    getDatabase(): object {
      return {};
    }
  }
  return {
    ...actual,
    SessionService: RecordingSessionService,
    getRequestScopedDatabase: () => undefined,
    getCurrentSessionPermissionContext: () => undefined,
    withSessionPermissionContext: async (
      options: { sessionId?: string | null },
      fn: (context: unknown) => Promise<unknown>,
    ) => {
      recorded.sessionCalls.push({ sessionId: options.sessionId });
      return fn({
        session: null,
        user: null,
        membership: null,
        permissions: [],
        tenantId: null,
        sessionId: null,
      });
    },
    withPrincipalPermissionContext: async (
      options: Record<string, unknown>,
      fn: (context: unknown) => Promise<unknown>,
    ) => {
      recorded.principalCalls.push(options);
      return fn({
        callerKind: 'guest',
        postgresRls: recorded.principalRls,
        permissions: recorded.principalRls
          ? (options.permissions as string[])
          : [],
        tenantId: recorded.principalRls ? options.tenantId : null,
        userId: null,
      });
    },
  };
});

const { composeSmrtSvelteKitRuntime } = await import('./sveltekit/runtime.js');

const DATABASE_URL = 'postgres://u:p@db.invalid/app';
const cloud = resolveApplicationRuntime({ profile: 'cloud' });
const selfHosted = resolveApplicationRuntime({ profile: 'self-hosted' });

// `initech` is an active tenant that holds no guest grants.
const TENANTS: Record<string, string> = {
  acme: 'tenant-a',
  globex: 'tenant-b',
  initech: 'tenant-c',
};
const GRANTS: Record<string, string[]> = {
  'tenant-a': ['products.read'],
  'tenant-b': ['widgets.read'],
};

const healthyCatalog: GuestCatalogPosture = {
  rolePosture: { rolsuper: false, rolbypassrls: false },
  ceilingTables: [
    {
      table: 'public.products',
      rowSecurity: true,
      forceRowSecurity: true,
      policyCount: 2,
    },
  ],
  expectedCeilingTables: ['public.products'],
};

function deployedStub(runtime: ResolvedApplicationRuntime) {
  return {
    db: {},
    resolvedRuntime: runtime,
    health: () => ({
      schemaVersion: 1,
      profile: runtime.profile,
      status: 'healthy',
    }),
    readiness: async () => ({ status: 'ready' }),
    close: async () => undefined,
  };
}

interface Scenario {
  readonly runtime?: ResolvedApplicationRuntime;
  readonly baseDomain?: string | undefined;
  readonly catalog?: GuestCatalogPosture | null | 'throw';
  readonly guestConfig?: unknown;
  readonly host?: string;
  readonly cookie?: string | undefined;
  readonly path?: string;
  readonly skipPaths?: string[];
  readonly defaultSelector?: boolean;
  readonly resolverCalls?: string[];
  readonly resolverThrows?: boolean;
  readonly probes?: { count: number };
}

async function request(scenario: Scenario = {}) {
  const resolved = scenario.runtime ?? cloud;
  const resolverCalls = scenario.resolverCalls ?? [];
  const runtime = composeSmrtSvelteKitRuntime(
    {
      appId: 'guest-app',
      runtime: resolved,
      env: { DATABASE_URL },
      providerReadiness: () => async () => undefined,
      enableTenancy: false,
      tenantBaseDomain:
        'baseDomain' in scenario ? scenario.baseDomain : 'base.test',
      selectTenant: async ({ url }) => {
        const slug = url.hostname.split('.')[0];
        return { tenantId: TENANTS[slug] ?? null, tenantSlug: slug };
      },
      ...(scenario.skipPaths
        ? { session: { skipPaths: scenario.skipPaths } }
        : {}),
    },
    {
      initializeDeployed: (async () =>
        deployedStub(resolved)) as unknown as never,
      guest: {
        defaultSelector: scenario.defaultSelector ?? true,
        baseDatabase: async () => ({}) as never,
        rawConfig: () =>
          'guestConfig' in scenario
            ? scenario.guestConfig
            : { collections: ['products', 'widgets'] },
        ceilingTables: () => [{ schemaName: 'public', tableName: 'products' }],
        probeCatalog: async () => {
          if (scenario.probes) scenario.probes.count += 1;
          if (scenario.catalog === 'throw') throw new Error('catalog down');
          return scenario.catalog === undefined
            ? healthyCatalog
            : scenario.catalog;
        },
        resolver: async () => ({
          resolveGuestPermissions: async (tenantId: string) => {
            resolverCalls.push(tenantId);
            if (scenario.resolverThrows) throw new Error('resolver down');
            return new Set(GRANTS[tenantId] ?? []);
          },
        }),
      },
    },
  );
  recorded.principalCalls.length = 0;
  recorded.sessionCalls.length = 0;
  const url = `https://${scenario.host ?? 'acme.base.test'}${scenario.path ?? '/'}`;
  const cookie = 'cookie' in scenario ? scenario.cookie : undefined;
  const locals: Record<string, unknown> = {};
  let downstreamCalls = 0;
  let seen: Record<string, unknown> = {};
  await Promise.resolve(
    runtime.handle({
      event: {
        url: new URL(url),
        request: new Request(url),
        cookies: {
          get: () => cookie,
          getAll: () => [],
          set: () => undefined,
          delete: () => undefined,
          serialize: () => '',
        },
        locals,
        getClientAddress: () => '203.0.113.1',
      } as unknown as Parameters<Handle>[0]['event'],
      resolve: async () => {
        downstreamCalls += 1;
        seen = { ...locals };
        return new Response('ok');
      },
    }),
  );
  return {
    locals: seen,
    downstreamCalls,
    principalCalls: [...recorded.principalCalls],
    sessionCalls: [...recorded.sessionCalls],
    resolverCalls,
  };
}

beforeEach(() => {
  enableTenancy();
  recorded.verdict = 'none';
  recorded.principalRls = true;
  setConfig({});
});
afterEach(() => {
  disableTenancy();
});

const anonymous = (result: Awaited<ReturnType<typeof request>>) => {
  expect(result.principalCalls).toEqual([]);
  expect(result.locals.guestPrincipal).toBeUndefined();
  expect(result.locals.tenantId).toBeNull();
  expect(result.locals.permissions).toEqual([]);
  expect(result.downstreamCalls).toBe(1);
};

describe('guest admission', () => {
  it('admits an unauthenticated request as a guest of the addressed tenant', async () => {
    const result = await request();
    expect(result.principalCalls).toHaveLength(1);
    expect(result.principalCalls[0]).toMatchObject({
      callerKind: 'guest',
      userId: null,
      tenantId: 'tenant-a',
      permissions: ['products.read'],
      enterTenantContext: true,
      postgresRls: true,
    });
    expect(result.locals.tenantId).toBe('tenant-a');
    expect(result.locals.permissions).toEqual(['products.read']);
    expect(result.locals.user).toBeNull();
    expect(result.locals.guestPrincipal).toMatchObject({
      callerKind: 'guest',
      userId: null,
      tenantId: 'tenant-a',
    });
    // The anonymous session scope is not also entered.
    expect(result.sessionCalls).toEqual([]);
    expect(result.downstreamCalls).toBe(1);
  });

  it('an address change selects only the other tenant own grants', async () => {
    const calls: string[] = [];
    const a = await request({ host: 'acme.base.test', resolverCalls: calls });
    const b = await request({ host: 'globex.base.test', resolverCalls: calls });
    expect(a.locals.permissions).toEqual(['products.read']);
    expect(b.locals.permissions).toEqual(['widgets.read']);
    expect(b.locals.tenantId).toBe('tenant-b');
    expect(calls).toEqual(['tenant-a', 'tenant-b']);
  });

  it('an unknown tenant, or no tenant address, is the anonymous path', async () => {
    anonymous(await request({ host: 'nobody.base.test' }));
    anonymous(await request({ host: 'localhost' }));
  });

  it('no grants is the anonymous path and looks like an unknown tenant', async () => {
    const known = await request({ host: 'initech.base.test' });
    const unknown = await request({ host: 'nobody.base.test' });
    anonymous(known);
    anonymous(unknown);
    expect(known.resolverCalls).toEqual(['tenant-c']);
  });

  it('a resolver failure is the anonymous path, not an error', async () => {
    anonymous(await request({ resolverThrows: true }));
  });
});

describe('guest gates fail closed', () => {
  it.each([
    ['guests not configured', { guestConfig: undefined }],
    ['malformed guest config', { guestConfig: { collections: 'products' } }],
    [
      'unknown guest config key',
      { guestConfig: { collections: ['p'], extra: 1 } },
    ],
    ['empty collections', { guestConfig: { collections: [] } }],
    [
      'create collection not listed',
      { guestConfig: { collections: ['p'], createCollections: ['q'] } },
    ],
    ['TENANT_BASE_DOMAIN unset', { baseDomain: undefined }],
    ['TENANT_BASE_DOMAIN blank', { baseDomain: '  ' }],
    ['custom tenant selector', { defaultSelector: false }],
    ['application isolation (no row-level security)', { runtime: selfHosted }],
    ['role posture unknown', { catalog: null }],
    ['catalog query failed', { catalog: 'throw' as const }],
    [
      'role bypasses RLS',
      {
        catalog: {
          ...healthyCatalog,
          rolePosture: { rolsuper: false, rolbypassrls: true },
        },
      },
    ],
    [
      'superuser role',
      {
        catalog: {
          ...healthyCatalog,
          rolePosture: { rolsuper: true, rolbypassrls: false },
        },
      },
    ],
    [
      'table not forced',
      {
        catalog: {
          ...healthyCatalog,
          ceilingTables: [
            { ...healthyCatalog.ceilingTables[0], forceRowSecurity: false },
          ],
        },
      },
    ],
    [
      'table has no policies',
      {
        catalog: {
          ...healthyCatalog,
          ceilingTables: [
            { ...healthyCatalog.ceilingTables[0], policyCount: 0 },
          ],
        },
      },
    ],
    [
      'ceiling table missing from the catalog',
      { catalog: { ...healthyCatalog, ceilingTables: [] } },
    ],
  ] as Array<[string, Scenario]>)('%s', async (_name, scenario) => {
    const result = await request({
      guestConfig: { collections: ['products'] },
      ...scenario,
    });
    anonymous(result);
  });

  it('tenancy installed but not enabled refuses guests', async () => {
    disableTenancy();
    anonymous(await request());
  });

  it('the door reporting no RLS leaves the request anonymous', async () => {
    recorded.principalRls = false;
    const result = await request();
    expect(result.principalCalls).toHaveLength(1);
    expect(result.locals.guestPrincipal).toBeUndefined();
    expect(result.locals.tenantId).toBeNull();
    expect(result.locals.permissions).toEqual([]);
    expect(result.downstreamCalls).toBe(1);
  });
});

describe('who is a guest', () => {
  it('a valid session never becomes a guest', async () => {
    recorded.verdict = 'valid';
    const result = await request({ cookie: 'session-id' });
    expect(result.principalCalls).toEqual([]);
    expect(result.sessionCalls).toHaveLength(1);
  });

  it('a signed-in non-member (session rejected by the tenant check) keeps today behaviour', async () => {
    recorded.verdict = 'rejected';
    const result = await request({ cookie: 'session-id' });
    expect(result.principalCalls).toEqual([]);
    expect(result.sessionCalls).toHaveLength(1);
    expect(result.locals.guestPrincipal).toBeUndefined();
    expect(result.locals.tenantId).toBeNull();
  });

  it('an unknown or expired session cookie is no session: a guest', async () => {
    recorded.verdict = 'none';
    const result = await request({ cookie: 'stale-id' });
    expect(result.principalCalls).toHaveLength(1);
    expect(result.locals.guestPrincipal).toBeDefined();
  });

  it('a skipped path never admits a guest', async () => {
    const result = await request({
      path: '/api/public/x',
      skipPaths: ['/api/public'],
    });
    expect(result.principalCalls).toEqual([]);
    expect(result.locals.guestPrincipal).toBeUndefined();
    expect(result.sessionCalls).toHaveLength(1);
  });

  it('guest locals do not survive into the next request on the same runtime', async () => {
    const first = await request();
    expect(first.locals.guestPrincipal).toBeDefined();
    // A fresh locals object per request, and clearSessionLocals resets reused
    // ones: a signed-in request that follows carries no guest marker.
    recorded.verdict = 'valid';
    const second = await request({ cookie: 'session-id' });
    expect(second.locals.guestPrincipal).toBeUndefined();
  });
});
