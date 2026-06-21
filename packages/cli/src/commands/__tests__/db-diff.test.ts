import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { autoDiscoverAndLoadMock } = vi.hoisted(() => ({
  autoDiscoverAndLoadMock: vi.fn(),
}));

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: autoDiscoverAndLoadMock,
}));

import { dbDiffCommand } from '../db-diff.js';

/**
 * db:diff against a REAL SQLite database and the REAL SchemaComparer.
 *
 * Discovery is mocked (it would scan the filesystem for manifests), and the
 * declared schema is supplied via a spy on
 * `ObjectRegistry.getAllSchemasAsDefinitions` — the same source the command
 * uses. Everything else (the comparer, the live introspection) runs for real
 * against a temp SQLite file we control, so the diff output reflects genuine
 * schema drift rather than a hand-built fixture.
 */
describe('db:diff (real SQLite + real SchemaComparer)', () => {
  let dbUrl: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let getSchemasSpy: ReturnType<typeof vi.spyOn>;

  async function createTable(sql: string): Promise<void> {
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    await db.query(sql);
    await db.close?.();
  }

  function declareSchema(defs: Record<string, any>): void {
    getSchemasSpy.mockReturnValue(defs as any);
  }

  beforeEach(() => {
    process.exitCode = undefined;
    dbUrl = join(
      tmpdir(),
      `cov-diff-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    } as any);

    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [{ path: '/fake/.smrt/manifest.json', source: 'project' }],
      totalObjects: 1,
    });

    getSchemasSpy = vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions');
    declareSchema({});

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCache();
    try {
      rmSync(dbUrl, { force: true });
    } catch {
      // ignore
    }
  });

  function output(): string {
    return logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  }

  function errorOutput(): string {
    return errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  }

  it('rejects unsupported file-migration options with a guidance error', async () => {
    await dbDiffCommand.handler([], { generate: true });

    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toContain('--generate');
    expect(errorOutput()).toContain('manifest-driven');
  });

  it('rejects unsupported file-migration options in JSON mode', async () => {
    await dbDiffCommand.handler([], { name: 'my_migration', json: true });

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output());
    expect(parsed.error).toContain('--name');
  });

  it('errors out when the database is configured as :memory:', async () => {
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: ':memory:' } } },
    } as any);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as any);

    await dbDiffCommand.handler([], {});

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorOutput()).toContain('Database configuration required');
    exitSpy.mockRestore();
  });

  it('exits when no manifests are discovered', async () => {
    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [],
      totalObjects: 0,
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as any);

    await dbDiffCommand.handler([], {});

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorOutput()).toContain('No SMRT manifests found');
    exitSpy.mockRestore();
  });

  it('emits a JSON error when no manifests are discovered (json mode)', async () => {
    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [],
      totalObjects: 0,
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as any);

    await dbDiffCommand.handler([], { json: true });

    expect(output()).toContain('No manifests found');
    exitSpy.mockRestore();
  });

  it('reports an up-to-date schema when the manifest matches the live DB', async () => {
    await createTable('CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT)');
    declareSchema({
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
        },
        indexes: [],
      },
    });

    await dbDiffCommand.handler([], {});

    expect(output()).toContain('up to date');
  });

  it('detects a missing table as an added-table change', async () => {
    declareSchema({
      gadgets: {
        tableName: 'gadgets',
        columns: { id: { type: 'TEXT', primaryKey: true } },
        indexes: [],
      },
    });

    await dbDiffCommand.handler([], {});

    const out = output();
    expect(out).toContain('Changes Detected');
    expect(out).toContain('New tables');
    expect(out).toContain('gadgets');
  });

  it('detects a missing column as an add_column change', async () => {
    await createTable('CREATE TABLE widgets (id TEXT PRIMARY KEY)');
    declareSchema({
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          price: { type: 'REAL' },
        },
        indexes: [],
      },
    });

    await dbDiffCommand.handler([], {});

    const out = output();
    expect(out).toContain('New columns');
    expect(out).toContain('widgets.price');
  });

  it('emits the structured diff as JSON', async () => {
    await createTable('CREATE TABLE widgets (id TEXT PRIMARY KEY)');
    declareSchema({
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          price: { type: 'REAL' },
        },
        indexes: [],
      },
    });

    await dbDiffCommand.handler([], { json: true });

    const parsed = JSON.parse(output());
    expect(parsed.hasChanges).toBe(true);
    expect(parsed.changes.some((c: any) => c.type === 'add_column')).toBe(true);
  });

  it('lists new indexes the manifest declares but the live DB lacks', async () => {
    await createTable('CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT)');
    declareSchema({
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
        },
        indexes: [{ name: 'idx_widgets_name', columns: ['name'] }],
      },
    });

    await dbDiffCommand.handler([], {});

    const out = output();
    expect(out).toContain('New indexes');
    expect(out).toContain('idx_widgets_name');
  });

  it('reports type mismatches that require manual migration', async () => {
    // Live `status` is INTEGER while the manifest declares TEXT.
    await createTable(
      'CREATE TABLE widgets (id TEXT PRIMARY KEY, status INTEGER)',
    );
    declareSchema({
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          status: { type: 'TEXT' },
        },
        indexes: [],
      },
    });

    await dbDiffCommand.handler([], {});

    const out = output();
    expect(out).toContain('Type');
    expect(out).toContain('widgets.status');
  });

  it('lists orphan indexes to drop when --drop-indexes is set', async () => {
    await createTable('CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT)');
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    await db.query('CREATE INDEX idx_widgets_orphan ON widgets(name)');
    await db.close?.();
    declareSchema({
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
        },
        indexes: [],
      },
    });

    await dbDiffCommand.handler([], { 'drop-indexes': true });

    const out = output();
    expect(out).toContain('Indexes to drop');
    expect(out).toContain('idx_widgets_orphan');
  });

  it('groups a drop+add of the same index name as a recreate', async () => {
    await createTable(
      'CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT, code TEXT)',
    );
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    await db.query('CREATE INDEX idx_widgets_name ON widgets(name)');
    await db.close?.();
    // Manifest keeps the same index name but on a different column → the live
    // index must be dropped and recreated, which the command renders as a single
    // "recreate" action.
    declareSchema({
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
          code: { type: 'TEXT' },
        },
        indexes: [{ name: 'idx_widgets_name', columns: ['code'] }],
      },
    });

    await dbDiffCommand.handler([], { 'drop-indexes': true });

    const out = output();
    expect(out).toContain('Indexes to recreate');
    expect(out).toContain('idx_widgets_name');
  });

  it('reports a failure when schema comparison throws', async () => {
    // An invalid schema definition (missing the columns/indexes shape) makes
    // the real comparer throw, exercising the command's error branch.
    await createTable('CREATE TABLE broken (id TEXT PRIMARY KEY)');
    // Existing table with a malformed manifest entry (no `indexes`) makes the
    // real comparer throw while comparing the live table, hitting the error
    // branch.
    declareSchema({
      broken: {
        tableName: 'broken',
        columns: { id: { type: 'TEXT', primaryKey: true } },
      },
    });

    await dbDiffCommand.handler([], {});

    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toContain('Failed to generate diff');
  });

  it('reports a JSON failure when schema comparison throws', async () => {
    await createTable('CREATE TABLE broken (id TEXT PRIMARY KEY)');
    // Existing table with a malformed manifest entry (no `indexes`) makes the
    // real comparer throw while comparing the live table, hitting the error
    // branch.
    declareSchema({
      broken: {
        tableName: 'broken',
        columns: { id: { type: 'TEXT', primaryKey: true } },
      },
    });

    await dbDiffCommand.handler([], { json: true });

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output());
    expect(parsed.error).toBeDefined();
  });
});
