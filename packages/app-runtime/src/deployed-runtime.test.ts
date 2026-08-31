import {
  RuntimeProfileValidationError,
  resolveApplicationRuntime,
} from '@happyvertical/smrt-config';
import { ScheduleRunner, TaskRunner } from '@happyvertical/smrt-jobs';
import { SessionService } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DeployedApplicationRuntimeOptions,
  DeployedRuntimeError,
  initializeDeployedApplicationRuntime,
} from './deployed-runtime.js';

function databaseFixture() {
  const query = vi.fn(async () => ({ rows: [{ smrt_runtime_probe: 1 }] }));
  const close = vi.fn(async () => undefined);
  const db = { query, close } as unknown as DatabaseInterface;
  return { db, query, close };
}

async function closeDatabase(db: DatabaseInterface): Promise<void> {
  await db.close?.();
}

function selfHostedOptions(
  db: DatabaseInterface,
): DeployedApplicationRuntimeOptions {
  return {
    profile: 'self-hosted',
    database: {
      engine: 'postgres',
      connect: async () => db,
      close: closeDatabase,
    },
    authentication: {
      provider: 'oidc',
      readiness: async () => undefined,
    },
    assets: {
      provider: 's3-compatible',
      readiness: async () => undefined,
    },
    secrets: {
      provider: 'environment',
      readiness: async () => undefined,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deployed application runtime', () => {
  it('composes the self-hosted profile without changing portable surfaces', async () => {
    const { db, query } = databaseFixture();
    const prepareDatabase = vi.fn(async () => undefined);
    const initialized = await initializeDeployedApplicationRuntime({
      ...selfHostedOptions(db),
      prepareDatabase,
    });

    expect(query).toHaveBeenCalledWith('SELECT 1 AS smrt_runtime_probe');
    expect(prepareDatabase).toHaveBeenCalledWith(db);
    expect(initialized.db).toBe(db);
    expect(initialized.resolvedRuntime.profile).toBe('self-hosted');
    expect(initialized.resolvedRuntime.invariants).toEqual(
      resolveApplicationRuntime({ profile: 'local' }).invariants,
    );
    expect(initialized.resolvedRuntime.invariants).toMatchObject({
      generatedWebMcp: 'identical',
      webMcpExposurePolicy: 'identical',
      actionEffects: 'identical',
      approvalPolicy: 'identical',
      jobInvocation: 'identical',
    });
  });

  it('supports documented self-hosted overrides with explicit bindings', async () => {
    const { db } = databaseFixture();
    const initialized = await initializeDeployedApplicationRuntime({
      ...selfHostedOptions(db),
      providers: {
        authentication: { provider: 'magic-link' },
        tenancy: { mode: 'multi-tenant', context: 'required' },
        assets: { provider: 'local-files' },
        secrets: { provider: 'external' },
      },
      authentication: {
        provider: 'magic-link',
        readiness: async () => undefined,
      },
      assets: {
        provider: 'local-files',
        readiness: async () => undefined,
      },
      secrets: {
        provider: 'external',
        readiness: async () => undefined,
      },
    });

    expect(initialized.diagnostics()).toMatchObject({
      providers: {
        database: { provider: 'postgres', configured: true },
        authentication: { provider: 'magic-link', configured: true },
        assets: { provider: 'local-files', configured: true },
        secrets: { provider: 'external', configured: true },
      },
      tenancy: {
        mode: 'multi-tenant',
        context: 'required',
        rootTenantFallback: 'disabled',
      },
      workers: {
        topology: 'external',
        taskProcess: 'separate',
        scheduleProcess: 'separate',
        replicas: 'operator-managed',
      },
      secretValuesIncluded: false,
    });
  });

  it('composes cloud with required tenant context and scalable workers', async () => {
    const { db } = databaseFixture();
    const initialized = await initializeDeployedApplicationRuntime({
      profile: 'cloud',
      database: {
        engine: 'postgres',
        connect: async () => db,
        close: closeDatabase,
      },
      authentication: {
        provider: 'hosted-identity',
        readiness: async () => undefined,
      },
      assets: {
        provider: 'managed-object-storage',
        readiness: async () => undefined,
      },
      secrets: {
        provider: 'managed',
        readiness: async () => undefined,
      },
    });

    expect(initialized.diagnostics()).toMatchObject({
      tenancy: {
        mode: 'multi-tenant',
        context: 'required',
        isolation: 'database-rls',
        rootTenantFallback: 'disabled',
      },
      workers: {
        topology: 'scalable',
        replicas: 'horizontal',
      },
    });
  });

  it('rejects a cloud session without the required tenant context', async () => {
    const { db } = databaseFixture();
    vi.spyOn(SessionService.prototype, 'initialize').mockResolvedValue();
    vi.spyOn(SessionService.prototype, 'loadSessionContext').mockResolvedValue({
      user: {} as never,
      permissions: [],
      tenantId: null,
      sessionId: 'unscoped-session',
    });
    const initialized = await initializeDeployedApplicationRuntime({
      profile: 'cloud',
      database: {
        engine: 'postgres',
        connect: async () => db,
        close: closeDatabase,
      },
      authentication: {
        provider: 'hosted-identity',
        readiness: async () => undefined,
      },
      assets: {
        provider: 'managed-object-storage',
        readiness: async () => undefined,
      },
      secrets: {
        provider: 'managed',
        readiness: async () => undefined,
      },
    });

    await expect(
      initialized.restoreSession('unscoped-session'),
    ).rejects.toMatchObject({
      code: 'tenant_context_required',
      component: 'authentication',
    });
  });

  it('rejects a required tenant context without an active membership', async () => {
    const { db } = databaseFixture();
    vi.spyOn(SessionService.prototype, 'initialize').mockResolvedValue();
    vi.spyOn(SessionService.prototype, 'loadSessionContext').mockResolvedValue({
      user: {} as never,
      membership: null,
      permissions: [],
      tenantId: 'untrusted-tenant',
      sessionId: 'untrusted-session',
    });
    const initialized = await initializeDeployedApplicationRuntime({
      profile: 'cloud',
      database: {
        engine: 'postgres',
        connect: async () => db,
        close: closeDatabase,
      },
      authentication: {
        provider: 'hosted-identity',
        readiness: async () => undefined,
      },
      assets: {
        provider: 'managed-object-storage',
        readiness: async () => undefined,
      },
      secrets: {
        provider: 'managed',
        readiness: async () => undefined,
      },
    });

    await expect(
      initialized.restoreSession('untrusted-session'),
    ).rejects.toMatchObject({
      code: 'tenant_context_unauthorized',
      component: 'authentication',
    });
  });

  it('accepts a required tenant context backed by an active membership', async () => {
    const { db } = databaseFixture();
    const initialize = vi
      .spyOn(SessionService.prototype, 'initialize')
      .mockResolvedValue();
    vi.spyOn(SessionService.prototype, 'loadSessionContext').mockResolvedValue({
      user: {} as never,
      membership: { isActive: () => true } as never,
      permissions: [],
      tenantId: 'authorized-tenant',
      sessionId: 'authorized-session',
    });
    const initialized = await initializeDeployedApplicationRuntime({
      profile: 'cloud',
      database: {
        engine: 'postgres',
        connect: async () => db,
        close: closeDatabase,
      },
      authentication: {
        provider: 'hosted-identity',
        readiness: async () => undefined,
      },
      assets: {
        provider: 'managed-object-storage',
        readiness: async () => undefined,
      },
      secrets: {
        provider: 'managed',
        readiness: async () => undefined,
      },
    });

    await expect(
      initialized.restoreSession('authorized-session'),
    ).resolves.toMatchObject({ tenantId: 'authorized-tenant' });
    await initialized.restoreSession('authorized-session');
    expect(initialize).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'root/default tenant fallback',
      providers: {
        tenancy: { mode: 'default-tenant' as const },
      },
    },
    {
      name: 'unscoped tenant context',
      providers: {
        tenancy: { context: 'defaulted' as const },
      },
    },
    {
      name: 'owner bootstrap authentication',
      providers: {
        authentication: { provider: 'owner-bootstrap' as const },
      },
    },
  ])('rejects unsafe cloud $name before connecting', async ({ providers }) => {
    const { db } = databaseFixture();
    const connect = vi.fn(async () => db);
    await expect(
      initializeDeployedApplicationRuntime({
        profile: 'cloud',
        providers,
        database: { engine: 'postgres', connect, close: closeDatabase },
        authentication: {
          provider: 'hosted-identity',
          readiness: async () => undefined,
        },
        assets: {
          provider: 'managed-object-storage',
          readiness: async () => undefined,
        },
        secrets: {
          provider: 'managed',
          readiness: async () => undefined,
        },
      }),
    ).rejects.toBeInstanceOf(RuntimeProfileValidationError);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    { network: { exposure: 'loopback' as const } },
    { network: { tls: false as const } },
    { jobs: { topology: 'embedded' as const } },
    { tenancy: { mode: 'default-tenant' as const } },
    { authentication: { provider: 'owner-bootstrap' as const } },
  ])('rejects unsafe self-hosted selectors before connecting', async (providers) => {
    const { db } = databaseFixture();
    const connect = vi.fn(async () => db);
    await expect(
      initializeDeployedApplicationRuntime({
        ...selfHostedOptions(db),
        providers,
        database: { engine: 'postgres', connect, close: closeDatabase },
      }),
    ).rejects.toBeInstanceOf(RuntimeProfileValidationError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('requires public authentication and secret bindings before opening PostgreSQL', async () => {
    const { db } = databaseFixture();
    const connect = vi.fn(async () => db);
    const options = {
      ...selfHostedOptions(db),
      database: { engine: 'postgres' as const, connect, close: closeDatabase },
      authentication: undefined,
    } as unknown as DeployedApplicationRuntimeOptions;

    await expect(
      initializeDeployedApplicationRuntime(options),
    ).rejects.toMatchObject({
      code: 'invalid_configuration',
      component: 'authentication',
    });
    expect(connect).not.toHaveBeenCalled();

    await expect(
      initializeDeployedApplicationRuntime({
        ...selfHostedOptions(db),
        database: { engine: 'postgres', connect, close: closeDatabase },
        secrets: undefined,
      } as unknown as DeployedApplicationRuntimeOptions),
    ).rejects.toMatchObject({
      code: 'invalid_configuration',
      component: 'secrets',
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects mismatched provider adapters before any readiness side effects', async () => {
    const { db } = databaseFixture();
    const authReadiness = vi.fn(async () => undefined);
    const connect = vi.fn(async () => db);

    await expect(
      initializeDeployedApplicationRuntime({
        ...selfHostedOptions(db),
        database: { engine: 'postgres', connect, close: closeDatabase },
        authentication: {
          provider: 'magic-link',
          readiness: authReadiness,
        },
      }),
    ).rejects.toMatchObject({
      code: 'provider_mismatch',
      component: 'authentication',
    });
    expect(authReadiness).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('supports provider adapter instances and preserves their method receiver', async () => {
    const { db } = databaseFixture();
    class AssetAdapter {
      readonly provider = 's3-compatible' as const;
      checked = false;

      async readiness(): Promise<void> {
        this.checked = true;
      }
    }
    const assets = new AssetAdapter();

    await initializeDeployedApplicationRuntime({
      ...selfHostedOptions(db),
      assets,
    });

    expect(assets.checked).toBe(true);
  });

  it('fails closed and redacts provider errors containing credentials', async () => {
    const { db } = databaseFixture();
    const credential = 'postgresql://operator:secret@example.com/app';

    let failure: unknown;
    try {
      await initializeDeployedApplicationRuntime({
        ...selfHostedOptions(db),
        secrets: {
          provider: 'environment',
          readiness: async () => {
            throw new Error(`missing ${credential}`);
          },
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DeployedRuntimeError);
    expect(failure).toMatchObject({
      code: 'provider_unavailable',
      component: 'secrets',
    });
    expect(JSON.stringify(failure)).not.toContain(credential);
    expect((failure as Error).message).not.toContain(credential);
  });

  it('closes a connection when readiness or migration fails', async () => {
    const readinessFixture = databaseFixture();
    const closeReadiness = vi.fn(async () => undefined);
    await expect(
      initializeDeployedApplicationRuntime({
        ...selfHostedOptions(readinessFixture.db),
        database: {
          engine: 'postgres',
          connect: async () => readinessFixture.db,
          readiness: async () => {
            throw new Error('not ready');
          },
          close: closeReadiness,
        },
      }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(closeReadiness).toHaveBeenCalledWith(readinessFixture.db);

    const migrationFixture = databaseFixture();
    await expect(
      initializeDeployedApplicationRuntime({
        ...selfHostedOptions(migrationFixture.db),
        prepareDatabase: async () => {
          throw new DeployedRuntimeError(
            'provider_unavailable',
            'migration leaked postgresql://operator:secret@example.com/app',
            'database',
          );
        },
      }),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      message:
        'The PostgreSQL migration step failed; inspect the application migration logs.',
    });
    expect(migrationFixture.close).toHaveBeenCalledOnce();
  });

  it('uses the binding close callback for a malformed connection handle', async () => {
    const malformed = { pool: 'opaque' };
    const close = vi.fn(async () => undefined);

    await expect(
      initializeDeployedApplicationRuntime({
        ...selfHostedOptions(malformed as unknown as DatabaseInterface),
        database: {
          engine: 'postgres',
          connect: async () => malformed as unknown as DatabaseInterface,
          close,
        },
      }),
    ).rejects.toMatchObject({
      code: 'invalid_configuration',
      component: 'database',
    });
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.calls[0]?.[0]).toBe(malformed);
  });

  it('redacts and cleans a connection handle with a throwing query accessor', async () => {
    const credential = 'postgresql://operator:secret@example.com/app';
    const malformed = Object.defineProperty({}, 'query', {
      get: () => {
        throw new Error(credential);
      },
    });
    const close = vi.fn(async () => undefined);

    let failure: unknown;
    try {
      await initializeDeployedApplicationRuntime({
        ...selfHostedOptions(malformed as DatabaseInterface),
        database: {
          engine: 'postgres',
          connect: async () => malformed as DatabaseInterface,
          close,
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'invalid_configuration',
      component: 'database',
    });
    expect((failure as Error).message).not.toContain(credential);
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.calls[0]?.[0]).toBe(malformed);
  });

  it('rejects and cleans a malformed resolved database probe', async () => {
    const query = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const db = { query } as unknown as DatabaseInterface;

    await expect(
      initializeDeployedApplicationRuntime({
        ...selfHostedOptions(db),
        database: {
          engine: 'postgres',
          connect: async () => db,
          close,
        },
      }),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      component: 'database',
    });
    expect(close).toHaveBeenCalledWith(db);
  });

  it('requires a usable database close boundary', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const db = { query } as unknown as DatabaseInterface;
    const connect = vi.fn(async () => db);

    await expect(
      initializeDeployedApplicationRuntime({
        ...selfHostedOptions(db),
        database: { engine: 'postgres', connect } as never,
      }),
    ).rejects.toMatchObject({
      code: 'invalid_configuration',
      component: 'database',
    });
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('reports live readiness without revealing provider failure details', async () => {
    const { db } = databaseFixture();
    let assetsReady = true;
    const credential = 'object-secret-value';
    const initialized = await initializeDeployedApplicationRuntime({
      ...selfHostedOptions(db),
      assets: {
        provider: 's3-compatible',
        readiness: async () => {
          if (!assetsReady) throw new Error(credential);
        },
      },
    });

    expect(await initialized.readiness()).toMatchObject({
      status: 'ready',
      components: {
        database: { status: 'ready' },
        authentication: { status: 'ready' },
        assets: { status: 'ready' },
        secrets: { status: 'ready' },
      },
      secretValuesIncluded: false,
    });

    assetsReady = false;
    const notReady = await initialized.readiness();
    expect(notReady).toMatchObject({
      status: 'not-ready',
      components: { assets: { status: 'not-ready' } },
    });
    expect(JSON.stringify(notReady)).not.toContain(credential);
  });

  it('reports not-ready when a live database probe resolves malformed data', async () => {
    const { db, query } = databaseFixture();
    const initialized = await initializeDeployedApplicationRuntime(
      selfHostedOptions(db),
    );
    query.mockResolvedValueOnce(undefined as never);

    await expect(initialized.readiness()).resolves.toMatchObject({
      status: 'not-ready',
      components: { database: { status: 'not-ready' } },
    });
  });

  it('does not report ready after shutdown begins during a probe', async () => {
    const { db } = databaseFixture();
    let blockAuthentication = false;
    let releaseAuthentication!: () => void;
    const authenticationBlocked = new Promise<void>((resolve) => {
      releaseAuthentication = resolve;
    });
    const initialized = await initializeDeployedApplicationRuntime({
      ...selfHostedOptions(db),
      authentication: {
        provider: 'oidc',
        readiness: async () => {
          if (blockAuthentication) await authenticationBlocked;
        },
      },
    });

    blockAuthentication = true;
    const readiness = initialized.readiness();
    await Promise.resolve();
    await initialized.close();
    releaseAuthentication();

    await expect(readiness).resolves.toMatchObject({
      status: 'not-ready',
      components: {
        database: { status: 'not-ready' },
        authentication: { status: 'not-ready' },
        assets: { status: 'not-ready' },
        secrets: { status: 'not-ready' },
      },
    });
  });

  it('creates separate job and schedule workers against the shared database', async () => {
    const { db } = databaseFixture();
    const taskInitialize = vi
      .spyOn(TaskRunner.prototype, 'initialize')
      .mockResolvedValue(undefined);
    const scheduleInitialize = vi
      .spyOn(ScheduleRunner.prototype, 'initialize')
      .mockResolvedValue(undefined);
    const initialized = await initializeDeployedApplicationRuntime(
      selfHostedOptions(db),
    );

    const task = await initialized.createTaskWorker({ concurrency: 7 });
    const schedule = await initialized.createScheduleWorker({ batchSize: 9 });
    expect(task).toBeInstanceOf(TaskRunner);
    expect(schedule).toBeInstanceOf(ScheduleRunner);
    expect(taskInitialize).toHaveBeenCalledWith(db);
    expect(scheduleInitialize).toHaveBeenCalledWith(db);
  });

  it('does not return workers whose initialization finishes after shutdown', async () => {
    const { db } = databaseFixture();
    let releaseTask!: () => void;
    let releaseSchedule!: () => void;
    const taskBlocked = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const scheduleBlocked = new Promise<void>((resolve) => {
      releaseSchedule = resolve;
    });
    vi.spyOn(TaskRunner.prototype, 'initialize').mockReturnValue(taskBlocked);
    vi.spyOn(ScheduleRunner.prototype, 'initialize').mockReturnValue(
      scheduleBlocked,
    );
    const initialized = await initializeDeployedApplicationRuntime(
      selfHostedOptions(db),
    );

    const taskWorker = initialized.createTaskWorker();
    const scheduleWorker = initialized.createScheduleWorker();
    await Promise.resolve();
    await initialized.close();
    releaseTask();
    releaseSchedule();

    await expect(taskWorker).rejects.toMatchObject({ code: 'runtime_stopped' });
    await expect(scheduleWorker).rejects.toMatchObject({
      code: 'runtime_stopped',
    });
  });

  it('redacts database errors from worker initialization', async () => {
    const { db } = databaseFixture();
    const credential = 'postgresql://operator:secret@example.com/app';
    vi.spyOn(TaskRunner.prototype, 'initialize').mockRejectedValue(
      new Error(credential),
    );
    vi.spyOn(ScheduleRunner.prototype, 'initialize').mockRejectedValue(
      new Error(credential),
    );
    const initialized = await initializeDeployedApplicationRuntime(
      selfHostedOptions(db),
    );

    for (const createWorker of [
      () => initialized.createTaskWorker(),
      () => initialized.createScheduleWorker(),
    ]) {
      let failure: unknown;
      try {
        await createWorker();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: 'provider_unavailable',
        component: 'database',
      });
      expect((failure as Error).message).not.toContain(credential);
    }
  });

  it('redacts database errors from session restoration', async () => {
    const { db } = databaseFixture();
    const credential = 'postgresql://operator:secret@example.com/app';
    vi.spyOn(SessionService.prototype, 'initialize')
      .mockRejectedValueOnce(new Error(credential))
      .mockResolvedValue(undefined);
    vi.spyOn(SessionService.prototype, 'loadSessionContext').mockRejectedValue(
      new DeployedRuntimeError(
        'provider_unavailable',
        credential,
        'authentication',
      ),
    );
    const initialized = await initializeDeployedApplicationRuntime(
      selfHostedOptions(db),
    );

    for (const sessionId of ['initialization-failure', 'load-failure']) {
      let failure: unknown;
      try {
        await initialized.restoreSession(sessionId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: 'provider_unavailable',
        component: 'authentication',
      });
      expect((failure as Error).message).not.toContain(credential);
    }
  });

  it('does not return a session whose load finishes after shutdown', async () => {
    const { db } = databaseFixture();
    let releaseSession!: () => void;
    const sessionBlocked = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    vi.spyOn(SessionService.prototype, 'initialize').mockResolvedValue();
    const loadSession = vi
      .spyOn(SessionService.prototype, 'loadSessionContext')
      .mockImplementation(async () => {
        await sessionBlocked;
        return {
          user: {} as never,
          permissions: [],
          tenantId: null,
          sessionId: 'closing-session',
        };
      });
    const initialized = await initializeDeployedApplicationRuntime(
      selfHostedOptions(db),
    );

    const restored = initialized.restoreSession('closing-session');
    await vi.waitFor(() => expect(loadSession).toHaveBeenCalledOnce());
    await initialized.close();
    releaseSession();

    await expect(restored).rejects.toMatchObject({ code: 'runtime_stopped' });
  });

  it('owns an idempotent connection lifecycle and becomes not-ready after close', async () => {
    const { db, close } = databaseFixture();
    const initialized = await initializeDeployedApplicationRuntime(
      selfHostedOptions(db),
    );

    expect(initialized.health().status).toBe('healthy');
    await initialized.close();
    await initialized.close();
    expect(close).toHaveBeenCalledOnce();
    expect(initialized.health().status).toBe('stopped');
    expect(await initialized.readiness()).toMatchObject({
      status: 'not-ready',
      components: {
        database: { status: 'not-ready' },
        authentication: { status: 'not-ready' },
        assets: { status: 'not-ready' },
        secrets: { status: 'not-ready' },
      },
    });
    await expect(initialized.createTaskWorker()).rejects.toMatchObject({
      code: 'runtime_stopped',
    });
  });

  it('redacts close failures, stops use immediately, and permits cleanup retry', async () => {
    const { db } = databaseFixture();
    const credential = 'postgresql://operator:secret@example.com/app';
    let closeAttempts = 0;
    const close = vi.fn((): Promise<void> => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error(credential);
      return Promise.resolve();
    });
    const initialized = await initializeDeployedApplicationRuntime({
      ...selfHostedOptions(db),
      database: {
        engine: 'postgres',
        connect: async () => db,
        close,
      },
    });

    let failure: unknown;
    try {
      await initialized.close();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'provider_unavailable',
      component: 'database',
    });
    expect((failure as Error).message).not.toContain(credential);
    expect(initialized.health().status).toBe('stopped');
    await expect(initialized.createTaskWorker()).rejects.toMatchObject({
      code: 'runtime_stopped',
    });

    await initialized.close();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('returns deeply frozen secret-free diagnostics', async () => {
    const { db } = databaseFixture();
    const initialized = await initializeDeployedApplicationRuntime(
      selfHostedOptions(db),
    );
    const diagnostics = initialized.diagnostics();

    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics.providers.secrets)).toBe(true);
    expect(Object.isFrozen(diagnostics.runtime)).toBe(true);
    expect(Object.isFrozen(diagnostics.runtime.providers.database)).toBe(true);
    expect(JSON.stringify(diagnostics)).toContain(
      '"secretValuesIncluded":false',
    );
    expect(JSON.stringify(diagnostics)).not.toContain('readiness');
    expect(initialized.diagnostics()).toBe(diagnostics);
  });
});
