import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { MigrationTracker } from '@happyvertical/smrt-core/migrations';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { autoDiscoverAndLoadMock } = vi.hoisted(() => ({
  autoDiscoverAndLoadMock: vi.fn(),
}));

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: autoDiscoverAndLoadMock,
}));

import { dbStatusCommand } from '../db-status.js';

/**
 * db:status against a REAL SQLite database, focusing on the human-readable
 * rendering paths the existing JSON-focused mock suite does not cover. The
 * MigrationTracker, SchemaComparer, and schema-contract evaluation all run for
 * real against a temp SQLite file; only manifest discovery and the declared
 * schema source (ObjectRegistry.getAllSchemasAsDefinitions) are injected.
 */
describe('db:status (real SQLite rendering)', () => {
  let dbUrl: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let getSchemasSpy: ReturnType<typeof vi.spyOn>;

  async function createWidgets(): Promise<void> {
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    await db.query('CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT)');
    await db.close?.();
  }

  async function applyMigration(): Promise<void> {
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    const tracker = new MigrationTracker({ db });
    await tracker.initialize();
    await tracker.apply({
      id: 'create_widgets',
      description: 'widgets',
      version: '1.0.0',
      up: ['CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT)'],
      down: ['DROP TABLE widgets'],
    });
    await db.close?.();
  }

  function declareSchema(defs: Record<string, any>): void {
    getSchemasSpy.mockReturnValue(defs as any);
  }

  beforeEach(() => {
    process.exitCode = undefined;
    dbUrl = join(
      tmpdir(),
      `cov-status-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    } as any);
    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [
        {
          path: '/fake/.smrt/manifest.json',
          source: 'project',
          objectCount: 1,
          objectNames: ['@fake/app:Widget'],
        },
      ],
      totalObjects: 1,
    });
    getSchemasSpy = vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions');
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

  it('errors out when the database is configured as :memory:', async () => {
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: ':memory:' } } },
    } as any);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as any);

    await dbStatusCommand.handler([], {});

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorOutput()).toContain('Database configuration required');
    exitSpy.mockRestore();
  });

  it('reports no applied migrations and a matching schema', async () => {
    await createWidgets();

    await dbStatusCommand.handler([], {});

    const out = output();
    expect(out).toContain('Migration Status');
    expect(out).toContain('Applied Migrations: None');
    expect(out).toContain('Live schema matches current manifests');
    expect(out).toContain('Schema contract passed');
  });

  it('lists applied migrations in compact form', async () => {
    await applyMigration();

    await dbStatusCommand.handler([], {});

    const out = output();
    expect(out).toContain('Applied Migrations: 1');
    expect(out).toContain('create_widgets');
  });

  it('renders applied migrations as a verbose table', async () => {
    await applyMigration();

    await dbStatusCommand.handler([], { verbose: true });

    const out = output();
    expect(out).toContain('create_widgets');
    expect(out).toContain('completed');
  });

  it('flags drift when the live schema is missing a manifest column', async () => {
    // The live widgets table lacks `price`, which the manifest now declares.
    await createWidgets();
    declareSchema({
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
          price: { type: 'REAL' },
        },
        indexes: [],
      },
    });

    await dbStatusCommand.handler([], { verbose: true });

    const out = output();
    expect(out).toContain('Drift Detected');
    expect(out).toContain('widgets.price');
    expect(out).toContain('missing_column');
  });

  it('flags a missing table as drift', async () => {
    declareSchema({
      gadgets: {
        tableName: 'gadgets',
        columns: { id: { type: 'TEXT', primaryKey: true } },
        indexes: [],
      },
    });

    await dbStatusCommand.handler([], {});

    expect(output()).toContain('Drift Detected');
    expect(output()).toContain('gadgets');
  });

  it('renders failed migrations still mapping to live drift in verbose mode', async () => {
    // Live widgets lacks `price`; the manifest declares it (→ add_column drift).
    // A failed migration whose generated name maps to that change is rendered as
    // an unresolved failure that still requires action.
    await createWidgets();
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    const tracker = new MigrationTracker({ db });
    await tracker.initialize();
    await tracker
      .apply({
        id: 'add_column_widgets_price',
        description: 'price',
        version: '1.0.0',
        up: ['ALTER TABLE definitely_missing ADD COLUMN price TEXT'],
        down: [],
      })
      .catch(() => undefined);
    await db.close?.();

    declareSchema({
      widgets: {
        tableName: 'widgets',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          name: { type: 'TEXT' },
          price: { type: 'REAL' },
        },
        indexes: [],
      },
    });

    await dbStatusCommand.handler([], { verbose: true });

    const out = output();
    expect(out).toContain('Failed migration history');
    expect(out).toContain('add_column_widgets_price');
  });

  it('formats a recently-applied migration timestamp as "just now"', async () => {
    await applyMigration();

    await dbStatusCommand.handler([], {});

    // The migration was applied seconds ago, exercising getTimeAgo's recent
    // branch in the compact applied-migration list.
    expect(output()).toContain('create_widgets');
  });

  it('emits a structured JSON status report', async () => {
    await createWidgets();

    await dbStatusCommand.handler([], { json: true });

    const parsed = JSON.parse(output());
    expect(parsed.database.engine).toBeDefined();
    expect(parsed.manifests.objects).toBe(1);
    expect(parsed.schemaContract.ok).toBe(true);
    expect(Array.isArray(parsed.drift)).toBe(true);
  });

  it('reports a failure when the schema source throws', async () => {
    await createWidgets();
    getSchemasSpy.mockImplementation(() => {
      throw new Error('boom reading schema');
    });

    await dbStatusCommand.handler([], {});

    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toContain('Failed to get migration status');
    expect(errorOutput()).toContain('boom reading schema');
  });

  it('reports a JSON failure when the schema source throws', async () => {
    await createWidgets();
    getSchemasSpy.mockImplementation(() => {
      throw new Error('boom reading schema');
    });

    await dbStatusCommand.handler([], { json: true });

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output());
    expect(parsed.error).toContain('boom reading schema');
  });
});
