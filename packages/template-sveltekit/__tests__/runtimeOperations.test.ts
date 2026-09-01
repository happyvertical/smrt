import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { getDatabase } from '@happyvertical/sql';
import {
  matchesApplicationProcess,
  readOwnedProcess,
  sendTerminationSignal,
  writeProcessRecord,
} from '../template/scripts/smrt-process.mjs';
import {
  executeImportPlan,
  planImportTables,
  serializeExportBundle,
  validateImportBundle,
} from '../template/scripts/smrt-portability.mjs';
import { withOperationLock } from '../template/scripts/smrt-operation-lock.mjs';
import { createProviderReadinessProbe } from '../template/scripts/smrt-provider-readiness.mjs';
import {
  prepareApplicationStateRoot,
  resolveApplicationId,
  resolveApplicationStateRoot,
  runtimeConfigurationFingerprint,
} from '../template/scripts/smrt-runtime-identity.mjs';
import {
  acquireWriterLease,
  readActiveWriterLease,
} from '../template/scripts/smrt-writer-lease.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, '..', 'template');
const appDriver = readFileSync(join(template, 'scripts', 'smrt-app.mjs'), 'utf8');
const worker = readFileSync(join(template, 'scripts', 'smrt-worker.mjs'), 'utf8');
const migrationPreparation = readFileSync(
  join(template, 'scripts', 'smrt-prepare-migration.mjs'),
  'utf8',
);
const portabilitySource = readFileSync(
  join(template, 'scripts', 'smrt-portability.mjs'),
  'utf8',
);
const providerReadiness = readFileSync(
  join(template, 'scripts', 'smrt-provider-readiness.mjs'),
  'utf8',
);
const compose = readFileSync(join(template, 'compose.yaml'), 'utf8');
const hooks = readFileSync(join(template, 'src', 'hooks.server.ts'), 'utf8');
const healthRoute = readFileSync(
  join(template, 'src', 'routes', 'api', '_runtime', 'health', '+server.ts'),
  'utf8',
);
const dockerfile = readFileSync(join(template, 'Dockerfile'), 'utf8');

describe('profile-aware application operations', () => {
  it('uses app-runtime paths and emits secret-free recovery diagnostics', () => {
    expect(appDriver).toContain('resolveLocalRuntimePaths');
    expect(appDriver).toContain('initializeLocalApplicationRuntime');
    expect(appDriver).toContain('prepareDatabase: options.prepareDatabase');
    expect(appDriver).toContain("runPackageManager(['exec', 'smrt', 'db:migrate']");
    expect(appDriver).not.toContain("${args.join(' ')} failed");
    expect(appDriver).toContain("rawCommandArgs[0] === '--'");
    expect(appDriver).toContain('stateRoot: preparedStateRoot()');
    expect(appDriver).toContain("code: 'unsafe-local-bind'");
    expect(appDriver).toContain("code: 'migration-required'");
    expect(appDriver).toContain('secretValuesIncluded: false');
    expect(appDriver).toContain(
      'Configure and verify the installed ${component} provider readiness module.',
    );
    expect(appDriver).toContain('acquireWriterLease');
    expect(appDriver).toContain("flag: 'wx'");
    expect(appDriver).toContain('renameSync(temporary, destination)');
    expect(appDriver).toContain("new URL('/api/_runtime/health', url)");
    expect(appDriver).toContain('pathToFileURL(onboardingLaunchPath())');
    expect(appDriver).toContain("'onboarding-launch.html'");
    expect(appDriver).toContain('health.instance === instance');
    expect(appDriver).toContain('health.configuration === configuration');
    expect(appDriver).toContain('assertLocalOperation');
    for (const operation of ['app:install', 'app:recover', 'app:start', 'app:stop']) {
      expect(appDriver).toContain(`assertLocalOperation('${operation}')`);
    }
    expect(appDriver).toContain('SMRT_PROCESS_INSTANCE: instance');
    expect(healthRoute).toContain('SMRT_PROCESS_INSTANCE');
    expect(healthRoute).toContain('applicationRuntimeConfiguration');
    expect(healthRoute).toContain("applicationRuntime.profile === 'local'");
    expect(migrationPreparation).toContain('resolveApplicationId');
    expect(migrationPreparation).toContain('prepareLocalDatabaseStorage');
    expect(migrationPreparation).toContain('readActiveWriterLease');
    expect(migrationPreparation).toContain('withOperationLock');
    expect(migrationPreparation).toContain("['exec', 'smrt', 'db:migrate']");
    expect(portabilitySource).toContain(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    expect(portabilitySource).toContain('assetsIncluded: false');
    expect(portabilitySource).toContain('linkSync(temporaryPath, outputPath)');
    expect(appDriver).toContain('force: false');
    expect(appDriver).toContain("platform() === 'win32' ? 'pnpm.cmd' : 'pnpm'");
    expect(appDriver).toContain("shell: platform() === 'win32'");
    expect(appDriver).toContain('allowFailure: true');
    expect(appDriver).toContain("startsWith('pnpm')");
    expect(appDriver).toContain("label: 'pnpm build'");
    expect(appDriver).toContain('saveOnboardingLaunch(report.onboardingUrl)');
    expect(appDriver).toContain('if (!sendTerminationSignal(pid))');
    expect(migrationPreparation).toContain("process.platform === 'win32'");
    expect(migrationPreparation).toContain('shell: windowsFallback');
    expect(migrationPreparation).toContain("startsWith('pnpm')");
    expect(portabilitySource).toContain("custody: 'trusted-parent'");
    expect(hooks).toContain(
      'export const init: ServerInit = ensureApplicationRuntimeReady',
    );
    expect(appDriver).not.toMatch(/console\.(?:log|error)\(process\.env/);
    expect(dockerfile).toContain('ENV SMRT_RUNTIME_PROFILE=self-hosted');
    expect(dockerfile).toContain('USER node');
    expect(providerReadiness).toContain('checkReadiness');
    expect(providerReadiness).toContain('result?.ready !== true');
    expect(appDriver).not.toContain('SMRT_AUTH_READY');
  });

  it('documents the complete stopped recovery sequence', () => {
    const setupAction = readFileSync(
      join(template, 'src', 'routes', 'setup', '+page.server.ts'),
      'utf8',
    );
    expect(setupAction).toContain(
      'pnpm app:stop, pnpm app:recover, pnpm app:start, then pnpm app:open',
    );
  });

  it('treats an already-exited process as successfully terminated', () => {
    expect(
      sendTerminationSignal(123, () => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }),
    ).toBe(false);
    expect(() =>
      sendTerminationSignal(123, () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      }),
    ).toThrow('denied');
  });

  it('rejects a process command that does not prove application identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-process-test-'));
    const record = join(directory, 'app.pid');
    try {
      writeProcessRecord(record, {
        pid: process.pid,
        instance: 'invalid',
      });
      expect(readOwnedProcess(record)).toBeNull();
      expect(existsSync(record)).toBe(false);
      expect(
        matchesApplicationProcess(
          { instance: '0123456789abcdef0123456789abcdef' },
          'node other-service.mjs',
        ),
      ).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serializes application operations with one exclusive lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-operation-test-'));
    let release = () => {};
    try {
      const held = withOperationLock(directory, 'first', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      await expect(
        withOperationLock(directory, 'second', async () => {}),
      ).rejects.toThrow('Another application operation is active');
      release();
      await held;
      await expect(
        withOperationLock(directory, 'third', async () => 'done'),
      ).resolves.toBe('done');
    } finally {
      release();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prevents a direct writer from racing an active operator command', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-writer-operation-test-'));
    try {
      await withOperationLock(directory, 'backup', async (lock) => {
        expect(() => acquireWriterLease(directory)).toThrow(
          'application operation is active',
        );
        const managedStartLease = acquireWriterLease(directory, {
          operationInstance: lock.instance,
        });
        managedStartLease.release();
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires deployed provider modules to return verified readiness', async () => {
    const previous = process.env.SMRT_AUTH_READINESS_MODULE;
    try {
      delete process.env.SMRT_AUTH_READINESS_MODULE;
      await expect(
        createProviderReadinessProbe('authentication', {
          profile: 'self-hosted',
          provider: 'oidc',
        })(),
      ).rejects.toThrow('must name an installed provider readiness module');

      process.env.SMRT_AUTH_READINESS_MODULE =
        'data:text/javascript,export default async () => ({ ready: false })';
      await expect(
        createProviderReadinessProbe('authentication', {
          profile: 'self-hosted',
          provider: 'oidc',
        })(),
      ).rejects.toThrow('readiness check failed');

      process.env.SMRT_AUTH_READINESS_MODULE =
        'data:text/javascript,export async function checkReadiness() { return { ready: true } }';
      await expect(
        createProviderReadinessProbe('authentication', {
          profile: 'self-hosted',
          provider: 'oidc',
        })(),
      ).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.SMRT_AUTH_READINESS_MODULE;
      else process.env.SMRT_AUTH_READINESS_MODULE = previous;
    }
  });

  it('fails closed on live writers and removes only stale leases', () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-writer-test-'));
    try {
      writeFileSync(
        join(directory, 'writer.lease'),
        `${JSON.stringify({
          schemaVersion: 1,
          pid: 2_147_483_647,
          instance: '0123456789abcdef0123456789abcdef',
        })}\n`,
      );
      expect(readActiveWriterLease(directory)).toBeNull();
      expect(existsSync(join(directory, 'writer.lease'))).toBe(false);

      const lease = acquireWriterLease(directory);
      expect(readActiveWriterLease(directory)).toMatchObject({
        pid: process.pid,
      });
      lease.release();
      expect(readActiveWriterLease(directory)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reclaims a dead operation lock before admitting a writer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-stale-operation-test-'));
    try {
      writeFileSync(
        join(directory, 'operation.lock'),
        `${JSON.stringify({
          schemaVersion: 1,
          pid: 2_147_483_647,
          operation: 'setup',
          instance: '0123456789abcdef0123456789abcdef',
        })}\n`,
      );
      const lease = acquireWriterLease(directory);
      expect(existsSync(join(directory, 'operation.lock'))).toBe(false);
      lease.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses one package-derived application identity by default', () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-identity-test-'));
    try {
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ name: '@smrt-app/My Project' }),
      );
      expect(resolveApplicationId({ sourceRoot: directory })).toMatch(
        /^smrt-app-my-project-[a-f0-9]{10}$/,
      );
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ name: '@smrt-app/My_Project' }),
      );
      expect(resolveApplicationId({ sourceRoot: directory })).toMatch(
        /^[a-z0-9][a-z0-9.-]{0,62}$/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fingerprints runtime configuration without coupling identity to passwords', () => {
    const runtime = {
      profile: 'self-hosted',
      providers: { database: { engine: 'postgres' } },
    };
    const initial = runtimeConfigurationFingerprint(runtime, {
      DATABASE_URL: 'postgresql://user:first@db.example/app',
      HOST: '0.0.0.0',
      PORT: '3000',
    });
    expect(
      runtimeConfigurationFingerprint(runtime, {
        DATABASE_URL: 'postgresql://other:second@db.example/app',
        HOST: '0.0.0.0',
        PORT: '3000',
      }),
    ).toBe(initial);
    expect(
      runtimeConfigurationFingerprint(runtime, {
        DATABASE_URL: 'postgresql://user:second@other.example/app',
        HOST: '0.0.0.0',
        PORT: '3000',
      }),
    ).not.toBe(initial);
    const sslRequired = runtimeConfigurationFingerprint(runtime, {
      DATABASE_URL:
        'postgresql://user:first@db.example/app?sslmode=require&password=hidden',
      HOST: '0.0.0.0',
      PORT: '3000',
    });
    expect(sslRequired).not.toBe(initial);
    expect(
      runtimeConfigurationFingerprint(runtime, {
        DATABASE_URL:
          'postgresql://other:changed@db.example/app?password=different&sslmode=require',
        HOST: '0.0.0.0',
        PORT: '3000',
      }),
    ).toBe(sslRequired);
    expect(
      runtimeConfigurationFingerprint(runtime, {
        DATABASE_URL: 'postgresql://user:first@db.example/app',
        HOST: '0.0.0.0',
        PORT: '3000',
        SMRT_AUTH_READINESS_MODULE: '@example/auth-readiness-v2',
      }),
    ).not.toBe(initial);
  });

  it('derives one private state/lock domain from the app and data identity', () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), 'smrt-state-test-')),
    );
    const sourceRoot = join(directory, 'source');
    mkdirSync(sourceRoot);
    try {
      const options = {
        appId: 'state-proof',
        dataDirectory: join(directory, 'data'),
        sourceRoot,
        platformName: 'linux',
        homeDirectory: directory,
        environment: { XDG_STATE_HOME: join(directory, 'state-home') },
      };
      const stateRoot = prepareApplicationStateRoot(options);
      expect(stateRoot).toMatch(
        new RegExp(
          `^${join(directory, 'state-home', '.state-proof-').replaceAll('.', '\\.')}` +
            '[a-f0-9]{12}-state$',
        ),
      );
      expect(resolveApplicationStateRoot(options)).toBe(stateRoot);
      expect(statSync(stateRoot).mode & 0o777).toBe(0o700);
      expect(
        statSync(join(stateRoot, '.smrt-state-state-proof')).mode & 0o777,
      ).toBe(0o600);

      const redirected = join(directory, 'redirected-state');
      symlinkSync(sourceRoot, redirected);
      expect(() =>
        prepareApplicationStateRoot({
          appId: 'redirected',
          dataDirectory: join(directory, 'other-data'),
          sourceRoot,
          platformName: 'linux',
          homeDirectory: directory,
          environment: { XDG_STATE_HOME: redirected },
        }),
      ).toThrow(/unsafe/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects truncated and incomplete logical exports before import', () => {
    const expected = new Map([
      ['items', { name: 'items', columns: ['id', 'title'] }],
      ['owners', { name: 'owners', columns: ['id', 'name'] }],
    ]);
    expect(() =>
      validateImportBundle(
        {
          tables: [
            {
              name: 'items',
              columns: ['id', 'title'],
              rows: [{ id: '1', title: 'Proof' }],
            },
          ],
        },
        expected,
      ),
    ).toThrow('complete application schema');
    expect(() =>
      validateImportBundle(
        {
          tables: [
            {
              name: 'items',
              columns: ['id', 'title'],
              rows: [{ id: '1' }],
            },
            {
              name: 'owners',
              columns: ['id', 'name'],
              rows: [],
            },
          ],
        },
        expected,
      ),
    ).toThrow('incomplete columns');
  });

  it('serializes lossless SQLite integers as portable decimal strings', () => {
    expect(
      JSON.parse(
        serializeExportBundle({ rows: [{ count: 9_007_199_254_740_993n }] }),
      ),
    ).toEqual({ rows: [{ count: '9007199254740993' }] });
  });

  it('orders parents first and defers nullable cyclic references', () => {
    const parent = {
      name: 'z_parents',
      columns: ['id'],
      columnDefinitions: { id: { primaryKey: true, notNull: true } },
      foreignKeys: [],
      primaryKeys: ['id'],
    };
    const child = {
      name: 'a_children',
      columns: ['id', 'parent_id'],
      columnDefinitions: {
        id: { primaryKey: true, notNull: true },
        parent_id: {
          notNull: false,
          foreignKey: { table: 'z_parents' },
        },
      },
      foreignKeys: [
        { column: 'parent_id', referencesTable: 'z_parents' },
      ],
      primaryKeys: ['id'],
    };
    expect(planImportTables([child, parent]).map((table) => table.name)).toEqual(
      ['z_parents', 'a_children'],
    );

    const left = {
      ...parent,
      name: 'left',
      columns: ['id', 'right_id'],
      columnDefinitions: {
        ...parent.columnDefinitions,
        right_id: { notNull: false, foreignKey: { table: 'right' } },
      },
      foreignKeys: [{ column: 'right_id', referencesTable: 'right' }],
    };
    const right = {
      ...parent,
      name: 'right',
      columns: ['id', 'left_id'],
      columnDefinitions: {
        ...parent.columnDefinitions,
        left_id: { notNull: false, foreignKey: { table: 'left' } },
      },
      foreignKeys: [{ column: 'left_id', referencesTable: 'left' }],
    };
    const cycle = planImportTables([right, left]);
    expect(cycle[0].deferredColumns.size).toBe(1);
    expect(cycle[1].deferredColumns.size).toBe(0);
  });

  it('executes parent/cycle imports and rolls failures back atomically', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      await db.query('PRAGMA foreign_keys = ON');
      await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY)');
      await db.query(
        'CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parents(id))',
      );
      const parent = {
        name: 'parents',
        columns: ['id'],
        columnDefinitions: { id: { primaryKey: true, notNull: true } },
        foreignKeys: [],
        primaryKeys: ['id'],
      };
      const child = {
        name: 'children',
        columns: ['id', 'parent_id'],
        columnDefinitions: {
          id: { primaryKey: true, notNull: true },
          parent_id: {
            notNull: true,
            foreignKey: { table: 'parents' },
          },
        },
        foreignKeys: [{ column: 'parent_id', referencesTable: 'parents' }],
        primaryKeys: ['id'],
      };
      const relationPlan = planImportTables([child, parent]);
      await db.transaction((tx) =>
        executeImportPlan(
          tx,
          relationPlan,
          new Map([
            ['parents', { rows: [{ id: 'parent-1' }] }],
            [
              'children',
              { rows: [{ id: 'child-1', parent_id: 'parent-1' }] },
            ],
          ]),
        ),
      );
      expect((await db.query('SELECT parent_id FROM children')).rows).toEqual([
        { parent_id: 'parent-1' },
      ]);

      await db.query(
        'CREATE TABLE left_nodes (id TEXT PRIMARY KEY, right_id TEXT REFERENCES right_nodes(id))',
      );
      await db.query(
        'CREATE TABLE right_nodes (id TEXT PRIMARY KEY, left_id TEXT REFERENCES left_nodes(id))',
      );
      const left = {
        name: 'left_nodes',
        columns: ['id', 'right_id'],
        columnDefinitions: {
          id: { primaryKey: true, notNull: true },
          right_id: {
            notNull: false,
            foreignKey: { table: 'right_nodes' },
          },
        },
        foreignKeys: [{ column: 'right_id', referencesTable: 'right_nodes' }],
        primaryKeys: ['id'],
      };
      const right = {
        name: 'right_nodes',
        columns: ['id', 'left_id'],
        columnDefinitions: {
          id: { primaryKey: true, notNull: true },
          left_id: {
            notNull: false,
            foreignKey: { table: 'left_nodes' },
          },
        },
        foreignKeys: [{ column: 'left_id', referencesTable: 'left_nodes' }],
        primaryKeys: ['id'],
      };
      await db.transaction((tx) =>
        executeImportPlan(
          tx,
          planImportTables([right, left]),
          new Map([
            ['left_nodes', { rows: [{ id: 'left-1', right_id: 'right-1' }] }],
            ['right_nodes', { rows: [{ id: 'right-1', left_id: 'left-1' }] }],
          ]),
        ),
      );
      expect((await db.query('SELECT right_id FROM left_nodes')).rows).toEqual([
        { right_id: 'right-1' },
      ]);
      expect((await db.query('SELECT left_id FROM right_nodes')).rows).toEqual([
        { left_id: 'left-1' },
      ]);

      await db.query('CREATE TABLE rollback_items (id TEXT PRIMARY KEY)');
      const rollbackTable = {
        name: 'rollback_items',
        columns: ['id'],
        columnDefinitions: { id: { primaryKey: true, notNull: true } },
        foreignKeys: [],
        primaryKeys: ['id'],
        deferredColumns: new Set(),
      };
      await expect(
        db.transaction((tx) =>
          executeImportPlan(
            tx,
            [rollbackTable],
            new Map([
              ['rollback_items', { rows: [{ id: 'same' }, { id: 'same' }] }],
            ]),
          ),
        ),
      ).rejects.toThrow();
      expect(
        Number(
          (await db.query('SELECT COUNT(*) AS count FROM rollback_items')).rows[0]
            ?.count || 0,
        ),
      ).toBe(0);
    } finally {
      await db.close?.();
    }
  });

  it('keeps browser opening testable without launching a real browser', () => {
    expect(appDriver).toContain('SMRT_OPEN_STUB');
    expect(appDriver).toContain('waitForReady');
    expect(appDriver).toContain("platform() === 'darwin'");
    expect(appDriver).toContain("'xdg-open'");
  });

  it('provides separate deployed web and worker processes', () => {
    expect(worker).toContain('initializeDeployedApplicationRuntime');
    expect(worker).toContain('createTaskWorker');
    expect(worker).toContain('createScheduleWorker');
    expect(compose).toContain('worker:');
    expect(compose).toContain('schedule-worker:');
    expect(compose).toContain('migrate:');
    expect(compose).toContain('condition: service_completed_successfully');
    expect(compose).toContain('command: node build');
    expect(compose).toContain('${POSTGRES_PASSWORD:?');
    expect(compose).toContain('${DATABASE_URL:?');
    expect(compose).not.toContain('change-me');
    expect(dockerfile).toContain(
      'RUN pnpm install --frozen-lockfile --prod=false',
    );
    expect(dockerfile).not.toContain('pnpm install --prod');
    expect(dockerfile).toContain('COPY --from=build /app/.smrt ./.smrt');
  });
});
