/**
 * Tenancy isolation and the request RLS transaction (review F3, G1, G2).
 *
 * The live PostgreSQL transaction/GUC path is owned and tested by
 * smrt-users; here the users session layer is replaced with a recorder that
 * models its request scope (an AsyncLocalStorage store carrying the
 * request-scoped database and whether the RLS transaction is active), so the
 * tests prove what reaches that layer and what application code receives,
 * without a database.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ResolvedApplicationRuntime,
  resolveApplicationRuntime,
} from '@happyvertical/smrt-config';
import {
  createGeneratedCollectionAccess,
  ObjectRegistry,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import type { Handle } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface RecordedScope {
  readonly database: { readonly label: string };
  readonly postgresRls: boolean;
}

const recorded = vi.hoisted(() => ({
  calls: [] as Array<{
    postgresRls: boolean | undefined;
    sessionId: string | null | undefined;
  }>,
  scope: undefined as unknown as AsyncLocalStorage<RecordedScope>,
}));
recorded.scope = new AsyncLocalStorage<RecordedScope>();

vi.mock('@happyvertical/smrt-users/sveltekit', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@happyvertical/smrt-users/sveltekit')
    >();
  return {
    ...actual,
    // The c9be4ed30 implementation built its session layer here.
    createSessionHandler: (options: { postgresRls?: boolean }) => {
      recorded.calls.push({ postgresRls: options.postgresRls, sessionId: '?' });
      return (({ event, resolve }) => resolve(event)) as unknown as ReturnType<
        typeof actual.createSessionHandler
      >;
    },
  };
});

vi.mock('@happyvertical/smrt-users', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happyvertical/smrt-users')>();
  class RecordingSessionService {
    async initialize(): Promise<void> {}
    async loadSessionContext(): Promise<null> {
      return null;
    }
    getDatabase(): object {
      return {};
    }
  }
  return {
    ...actual,
    SessionService: RecordingSessionService,
    getRequestScopedDatabase: () => recorded.scope.getStore()?.database,
    getCurrentSessionPermissionContext: () => recorded.scope.getStore(),
    withSessionPermissionContext: async (
      options: { postgresRls?: boolean; sessionId?: string | null },
      fn: (context: unknown) => Promise<unknown>,
    ) => {
      recorded.calls.push({
        postgresRls: options.postgresRls,
        sessionId: options.sessionId,
      });
      // Like smrt-users: a request database always exists inside the scope;
      // it is the RLS transaction only when postgresRls is active.
      return recorded.scope.run(
        {
          database: {
            label: options.postgresRls ? 'rls-transaction' : 'base-connection',
          },
          postgresRls: options.postgresRls === true,
        },
        () =>
          fn({
            session: null,
            user: null,
            membership: null,
            permissions: [],
            tenantId: null,
            sessionId: null,
          }),
      );
    },
  };
});

const { composeSmrtSvelteKitRuntime } = await import('./sveltekit/runtime.js');

const DATABASE_URL = 'postgres://u:p@db.invalid/app';
const cloud = resolveApplicationRuntime({ profile: 'cloud' });
const selfHosted = resolveApplicationRuntime({ profile: 'self-hosted' });

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

interface RequestOptions {
  readonly session?: { postgresRls?: boolean; skipPaths?: string[] };
  readonly classOverrides?: Record<string, Partial<SmrtClassOptions>>;
  readonly path?: string;
  readonly cookie?: string | undefined;
  readonly downstream?: (
    runtime: ReturnType<typeof composeSmrtSvelteKitRuntime>,
  ) => Promise<Response>;
}

function runtimeFor(
  resolved: ResolvedApplicationRuntime,
  options: RequestOptions = {},
) {
  return composeSmrtSvelteKitRuntime(
    {
      appId: 'rls-app',
      runtime: resolved,
      env: { DATABASE_URL },
      providerReadiness: () => async () => undefined,
      enableTenancy: false,
      ...(options.session ? { session: options.session } : {}),
      ...(options.classOverrides
        ? { classOverrides: options.classOverrides }
        : {}),
    },
    {
      initializeDeployed: (async () =>
        deployedStub(resolved)) as unknown as never,
    },
  );
}

async function request(
  resolved: ResolvedApplicationRuntime,
  options: RequestOptions = {},
) {
  recorded.calls.length = 0;
  const runtime = runtimeFor(resolved, options);
  const url = `https://app.example.test${options.path ?? '/'}`;
  const cookie = 'cookie' in options ? options.cookie : 'session-id';
  let downstreamCalls = 0;
  const outcome = await Promise.resolve(
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
        locals: {},
        getClientAddress: () => '203.0.113.1',
      } as unknown as Parameters<Handle>[0]['event'],
      resolve: async () => {
        downstreamCalls += 1;
        return options.downstream
          ? options.downstream(runtime)
          : new Response('ok');
      },
    }),
  ).then(
    (response) => ({ response, error: undefined as unknown }),
    (error: unknown) => ({ response: undefined, error }),
  );
  return { ...outcome, runtime, downstreamCalls, calls: [...recorded.calls] };
}

describe('F3: tenancy isolation drives the request RLS transaction', () => {
  it('enables postgresRls for database-rls isolation', async () => {
    expect(cloud.providers.tenancy.isolation).toBe('database-rls');
    const { calls } = await request(cloud);
    expect(calls.map((call) => call.postgresRls)).toEqual([true]);
  });

  it('does not let options.session turn RLS off for database-rls isolation', async () => {
    const { calls } = await request(cloud, {
      session: { postgresRls: false },
    });
    expect(calls.map((call) => call.postgresRls)).toEqual([true]);
  });

  it('keeps the caller choice for application isolation', async () => {
    expect(selfHosted.providers.tenancy.isolation).toBe('application');
    expect(
      (await request(selfHosted)).calls.map((call) => call.postgresRls),
    ).toEqual([undefined]);
    expect(
      (await request(selfHosted, { session: { postgresRls: true } })).calls.map(
        (call) => call.postgresRls,
      ),
    ).toEqual([true]);
  });
});

describe('G1: skip paths never escape mandatory RLS isolation', () => {
  const skipped = {
    session: { skipPaths: ['/api/public'] },
    path: '/api/public/x',
  };

  it('runs a skipped path inside the RLS context with an anonymous principal', async () => {
    let scope: RecordedScope | undefined;
    const result = await request(cloud, {
      ...skipped,
      downstream: async () => {
        scope = recorded.scope.getStore();
        return new Response('ok');
      },
    });
    expect(result.response?.status).toBe(200);
    expect(result.calls).toEqual([{ postgresRls: true, sessionId: null }]);
    expect(scope?.postgresRls).toBe(true);
    expect(result.downstreamCalls).toBe(1);
  });

  it('keeps run-once error propagation on a skipped RLS path', async () => {
    const boom = new Error('downstream failure');
    const result = await request(cloud, {
      ...skipped,
      downstream: async () => {
        throw boom;
      },
    });
    expect(result.error).toBe(boom);
    expect(result.downstreamCalls).toBe(1);
  });

  it('leaves skip paths unchanged under application isolation', async () => {
    let scope: RecordedScope | undefined;
    const result = await request(selfHosted, {
      ...skipped,
      downstream: async () => {
        scope = recorded.scope.getStore();
        return new Response('ok');
      },
    });
    expect(result.response?.status).toBe(200);
    expect(result.calls).toEqual([]);
    expect(scope).toBeUndefined();
    expect(result.downstreamCalls).toBe(1);
  });
});

describe('G2: classOptions() follows the request RLS transaction', () => {
  const base = { type: 'postgres', url: DATABASE_URL };

  it('returns the request-scoped database inside an RLS request and the base config outside', async () => {
    let inside: SmrtClassOptions | undefined;
    let insideDb: unknown;
    const result = await request(cloud, {
      downstream: async (runtime) => {
        inside = runtime.classOptions('Item');
        insideDb = runtime.databaseConfig();
        return new Response('ok');
      },
    });
    expect(result.response?.status).toBe(200);
    expect(inside?.db).toEqual({ label: 'rls-transaction' });
    expect(insideDb).toEqual({ label: 'rls-transaction' });
    // After the request the same runtime is back on the base configuration.
    expect(result.runtime.classOptions('Item').db).toEqual(base);
    expect(result.runtime.databaseConfig()).toEqual(base);
  });

  it('applies to anonymous RLS requests too', async () => {
    let inside: SmrtClassOptions | undefined;
    await request(cloud, {
      cookie: undefined,
      downstream: async (runtime) => {
        inside = runtime.classOptions('Item');
        return new Response('ok');
      },
    });
    expect(inside?.db).toEqual({ label: 'rls-transaction' });
  });

  it('keeps an explicit per-class database override', async () => {
    const audit = { type: 'postgres', url: 'postgres://audit.invalid/db' };
    let overridden: SmrtClassOptions | undefined;
    let other: SmrtClassOptions | undefined;
    await request(cloud, {
      classOverrides: { AuditLog: { db: audit } },
      downstream: async (runtime) => {
        overridden = runtime.classOptions('AuditLog');
        other = runtime.classOptions('Item');
        return new Response('ok');
      },
    });
    expect(overridden?.db).toEqual(audit);
    expect(other?.db).toEqual({ label: 'rls-transaction' });
  });

  it('leaves application isolation on the base configuration', async () => {
    let inside: SmrtClassOptions | undefined;
    await request(selfHosted, {
      downstream: async (runtime) => {
        inside = runtime.classOptions('Item');
        return new Response('ok');
      },
    });
    expect(inside?.db).toEqual(base);
  });
});

describe('G3: getCollection() and generated routes use the request database (#3416)', () => {
  const base = { type: 'postgres', url: DATABASE_URL };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Records the options every collection is built from. */
  function recordCollections(): Array<{ className: string; db: unknown }> {
    const built: Array<{ className: string; db: unknown }> = [];
    vi.spyOn(ObjectRegistry, 'getCollection').mockImplementation(
      async (className, options) => {
        built.push({ className, db: options?.db });
        return { className } as never;
      },
    );
    return built;
  }

  it('builds each collection from the current RLS request transaction, never a retained one', async () => {
    const built = recordCollections();
    const requestDbs: unknown[] = [];
    let runtimeRef: ReturnType<typeof runtimeFor> | undefined;
    for (let index = 0; index < 2; index += 1) {
      const result = await request(cloud, {
        downstream: async (runtime) => {
          runtimeRef = runtime;
          requestDbs.push(recorded.scope.getStore()?.database);
          await runtime.getCollection('Item');
          return new Response('ok');
        },
      });
      expect(result.response?.status).toBe(200);
    }
    expect(built.map((entry) => entry.className)).toEqual(['Item', 'Item']);
    // Each request's own transaction-bound handle, by identity.
    expect(built[0]?.db).toBe(requestDbs[0]);
    expect(built[1]?.db).toBe(requestDbs[1]);
    expect(built[0]?.db).not.toBe(built[1]?.db);
    expect(built[0]?.db).toEqual({ label: 'rls-transaction' });

    // Outside any request the runtime is back on the base configuration.
    await runtimeRef?.getCollection('Item');
    expect(built[2]?.db).toEqual(base);
  });

  it('resolves generated route collections through runtime.getCollection()', async () => {
    const built = recordCollections();
    const result = await request(cloud, {
      classOverrides: { AuditLog: { db: { type: 'sqlite', url: 'audit' } } },
      downstream: async (runtime) => {
        // What the generated route prelude does with the app's `smrt.ts`.
        const { getCollection, getSmrtConfig } =
          createGeneratedCollectionAccess(
            { runtime },
            'src/lib/server/smrt.ts',
          );
        await getCollection('Item');
        await getCollection('AuditLog');
        expect(getSmrtConfig('Item').db).toEqual({ label: 'rls-transaction' });
        return new Response('ok');
      },
    });
    expect(result.response?.status).toBe(200);
    expect(built).toEqual([
      { className: 'Item', db: { label: 'rls-transaction' } },
      // An explicit per-class database override keeps its own database.
      { className: 'AuditLog', db: { type: 'sqlite', url: 'audit' } },
    ]);
  });

  it('keeps application isolation on the base configuration', async () => {
    const built = recordCollections();
    await request(selfHosted, {
      downstream: async (runtime) => {
        await runtime.getCollection('Item');
        return new Response('ok');
      },
    });
    expect(built).toEqual([{ className: 'Item', db: base }]);
  });
});
