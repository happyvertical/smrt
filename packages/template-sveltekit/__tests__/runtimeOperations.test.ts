import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  writeProcessRecord,
} from '../template/scripts/smrt-process.mjs';
import {
  executeImportPlan,
  planImportTables,
  validateImportBundle,
} from '../template/scripts/smrt-portability.mjs';
import { withOperationLock } from '../template/scripts/smrt-operation-lock.mjs';
import { resolveApplicationId } from '../template/scripts/smrt-runtime-identity.mjs';
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
    expect(appDriver).toContain("run('pnpm', ['exec', 'smrt', 'db:migrate']");
    expect(appDriver).toContain("rawCommandArgs[0] === '--'");
    expect(appDriver).toContain('stateRoot: stateRoot()');
    expect(appDriver).toContain("code: 'unsafe-local-bind'");
    expect(appDriver).toContain("code: 'migration-required'");
    expect(appDriver).toContain('secretValuesIncluded: false');
    expect(appDriver).toContain('readActiveWriterLease');
    expect(appDriver).toContain("new URL('/api/_runtime/health', url)");
    expect(appDriver).toContain('health.instance === instance');
    expect(appDriver).toContain('SMRT_PROCESS_INSTANCE: instance');
    expect(healthRoute).toContain('SMRT_PROCESS_INSTANCE');
    expect(migrationPreparation).toContain('resolveApplicationId');
    expect(migrationPreparation).toContain('prepareLocalDatabaseStorage');
    expect(migrationPreparation).toContain('readActiveWriterLease');
    expect(hooks).toContain(
      'export const init: ServerInit = ensureApplicationRuntimeReady',
    );
    expect(appDriver).not.toMatch(/console\.(?:log|error)\(process\.env/);
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
