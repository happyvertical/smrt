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
import {
  matchesApplicationProcess,
  readOwnedProcess,
  writeProcessRecord,
} from '../template/scripts/smrt-process.mjs';
import {
  planImportTables,
  validateImportBundle,
} from '../template/scripts/smrt-portability.mjs';
import { withOperationLock } from '../template/scripts/smrt-operation-lock.mjs';
import { resolveApplicationId } from '../template/scripts/smrt-runtime-identity.mjs';

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
    expect(migrationPreparation).toContain('resolveApplicationId');
    expect(migrationPreparation).toContain('resolveLocalRuntimePaths');
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

  it('uses one package-derived application identity by default', () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-identity-test-'));
    try {
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ name: '@smrt-app/My Project' }),
      );
      expect(resolveApplicationId({ sourceRoot: directory })).toBe(
        'smrt-app-my-project',
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
  });
});
