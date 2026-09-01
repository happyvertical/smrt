import { TaskRunner } from '@happyvertical/smrt-jobs';
import { SessionService, UserCollection } from '@happyvertical/smrt-users';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DeployedApplicationRuntime,
  initializeDeployedApplicationRuntime,
} from './deployed-runtime.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('deployed runtime on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let runtime: DeployedApplicationRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('rejects an unscoped hosted session and wires external workers through the same database', async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'User',
        'Session',
        'SmrtJob',
        'SmrtJobEvent',
        'SmrtWorker',
      ],
      prefix: 'app-runtime-deployed',
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database.');
    }
    const connected = isolated;

    const checks: string[] = [];
    runtime = await initializeDeployedApplicationRuntime({
      profile: 'cloud',
      database: {
        engine: 'postgres',
        connect: async () => connected.db,
        close: async () => {
          if (isolated === connected) {
            await connected.cleanup();
            isolated = undefined;
          }
        },
      },
      authentication: {
        provider: 'hosted-identity',
        readiness: async () => {
          checks.push('hosted-identity');
        },
      },
      assets: {
        provider: 'managed-object-storage',
        readiness: async () => {
          checks.push('managed-object-storage');
        },
      },
      secrets: {
        provider: 'managed',
        readiness: async () => {
          checks.push('managed-secrets');
        },
      },
      prepareDatabase: async (db) => {
        const result = await db.query('SELECT current_database() AS name');
        expect(result.rows[0]?.name).toBeTruthy();
      },
    });

    const users = await UserCollection.create({ db: runtime.db });
    const user = await users.create({
      email: 'runtime-postgres@example.com',
    });
    await user.save();
    if (!user.id) throw new Error('Expected a persisted PostgreSQL user.');

    const sessions = new SessionService({ db: runtime.db });
    await sessions.initialize();
    const sessionId = await sessions.createSession(user.id);
    await expect(runtime.restoreSession(sessionId)).rejects.toMatchObject({
      code: 'tenant_context_required',
      component: 'authentication',
    });

    const taskWorker = await runtime.createTaskWorker({ concurrency: 2 });
    expect(taskWorker).toBeInstanceOf(TaskRunner);
    expect(runtime.diagnostics()).toMatchObject({
      providers: {
        database: { provider: 'postgres', configured: true },
        authentication: { provider: 'hosted-identity', configured: true },
        assets: { provider: 'managed-object-storage', configured: true },
        secrets: { provider: 'managed', configured: true },
      },
      tenancy: {
        context: 'required',
        rootTenantFallback: 'disabled',
      },
      workers: { topology: 'scalable', replicas: 'horizontal' },
    });
    expect(checks).toEqual([
      'hosted-identity',
      'managed-object-storage',
      'managed-secrets',
    ]);
  });
});
