/**
 * F3: the resolved tenancy isolation selects the request RLS transaction.
 *
 * The live PostgreSQL transaction/GUC path is owned and tested by
 * smrt-users; here the session layer is replaced with a recorder so the test
 * proves which `postgresRls` value reaches it without a database.
 */

import {
  type ResolvedApplicationRuntime,
  resolveApplicationRuntime,
} from '@happyvertical/smrt-config';
import type { Handle } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

const recorded = vi.hoisted(() => ({
  postgresRls: [] as Array<boolean | undefined>,
}));

vi.mock('@happyvertical/smrt-users/sveltekit', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@happyvertical/smrt-users/sveltekit')
    >();
  return {
    ...actual,
    createSessionHandler: (options: { postgresRls?: boolean }) => {
      recorded.postgresRls.push(options.postgresRls);
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
    withSessionPermissionContext: async (
      options: { postgresRls?: boolean },
      fn: (context: unknown) => Promise<unknown>,
    ) => {
      recorded.postgresRls.push(options.postgresRls);
      return fn({
        session: null,
        user: null,
        membership: null,
        permissions: [],
        tenantId: null,
        sessionId: null,
      });
    },
  };
});

const { composeSmrtSvelteKitRuntime } = await import('./sveltekit/runtime.js');

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

async function effectiveRls(
  resolved: ResolvedApplicationRuntime,
  session?: { postgresRls?: boolean },
): Promise<boolean | undefined> {
  recorded.postgresRls.length = 0;
  const runtime = composeSmrtSvelteKitRuntime(
    {
      appId: 'rls-app',
      runtime: resolved,
      env: { DATABASE_URL: 'postgres://u:p@db.invalid/app' },
      providerReadiness: () => async () => undefined,
      enableTenancy: false,
      ...(session ? { session } : {}),
    },
    {
      initializeDeployed: (async () =>
        deployedStub(resolved)) as unknown as never,
    },
  );
  const response = await runtime.handle({
    event: {
      url: new URL('https://app.example.test/'),
      request: new Request('https://app.example.test/'),
      cookies: {
        get: () => 'session-id',
        getAll: () => [],
        set: () => undefined,
        delete: () => undefined,
        serialize: () => '',
      },
      locals: {},
      getClientAddress: () => '203.0.113.1',
    } as unknown as Parameters<Handle>[0]['event'],
    resolve: async () => new Response('ok'),
  });
  expect(response.status).toBe(200);
  expect(recorded.postgresRls).toHaveLength(1);
  return recorded.postgresRls[0];
}

describe('F3: tenancy isolation drives the request RLS transaction', () => {
  const cloud = resolveApplicationRuntime({ profile: 'cloud' });
  const selfHosted = resolveApplicationRuntime({ profile: 'self-hosted' });

  it('enables postgresRls for database-rls isolation', async () => {
    expect(cloud.providers.tenancy.isolation).toBe('database-rls');
    await expect(effectiveRls(cloud)).resolves.toBe(true);
  });

  it('does not let options.session turn RLS off for database-rls isolation', async () => {
    await expect(effectiveRls(cloud, { postgresRls: false })).resolves.toBe(
      true,
    );
  });

  it('keeps the caller choice for application isolation', async () => {
    expect(selfHosted.providers.tenancy.isolation).toBe('application');
    await expect(effectiveRls(selfHosted)).resolves.toBeFalsy();
    await expect(effectiveRls(selfHosted, { postgresRls: true })).resolves.toBe(
      true,
    );
  });
});
