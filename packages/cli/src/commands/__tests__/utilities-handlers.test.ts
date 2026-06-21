import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks. utilities.ts statically imports @happyvertical/smrt-core and
// ../discovery, then dynamically imports config / sql / json-validator /
// migrations. We provide controllable stand-ins for all of them.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const registry = {
    getAllClasses: vi.fn(() => new Map()),
    getAllSchemasAsDefinitions: vi.fn(() => [] as unknown[]),
    getClass: vi.fn(() => undefined as unknown),
    getFields: vi.fn(() => new Map()),
    getInheritanceChain: vi.fn((name: string) => [name]),
    getInitializationOrder: vi.fn(() => [] as string[]),
    getSTIBase: vi.fn(() => null as unknown),
    getTableName: vi.fn(() => null as unknown),
    getTableStrategy: vi.fn(() => 'cti'),
    getSchema: vi.fn(() => undefined as unknown),
    findClassesByName: vi.fn(() => [] as Array<{ qualifiedName?: string }>),
    getConflictColumns: vi.fn(() => [] as string[]),
  };
  return {
    registry,
    autoDiscoverAndLoad: vi.fn(),
    getPackageConfig: vi.fn(),
    getDatabase: vi.fn(),
    clearConnectionCache: vi.fn(),
    resolveDataPath: vi.fn(),
    discoverJsonFiles: vi.fn(),
    displayValidationResults: vi.fn(),
    validateFn: vi.fn(),
    generateSummary: vi.fn(),
    applyFixes: vi.fn(),
    trackerInitialize: vi.fn(async () => {}),
    trackerGetEngine: vi.fn(() => 'sqlite'),
    trackerApplyAll: vi.fn(async () => []),
    ensureSchema: vi.fn(async () => {}),
    generateSchema: vi.fn(async () => 'CREATE TABLE t ()'),
    schemaCompare: vi.fn(async () => ({ added_tables: [], changes: [] })),
    manifestGenerate: vi.fn(async () => ({
      objects: { '@app:Article': {} },
    })),
    discoverBaseClasses: vi.fn(async () => ['Base1', 'Base2', 'Base3']),
    rlQuestion: vi.fn(async () => 'y'),
    rlClose: vi.fn(),
    spawn: vi.fn(),
  };
});

const {
  registry,
  autoDiscoverAndLoad,
  getPackageConfig,
  getDatabase,
  clearConnectionCache,
  resolveDataPath,
  discoverJsonFiles,
  displayValidationResults,
  validateFn,
  generateSummary,
  applyFixes,
  trackerApplyAll,
  ensureSchema,
  generateSchema,
  schemaCompare,
  manifestGenerate,
  discoverBaseClasses,
  rlQuestion,
  spawn,
} = h;

// A migration-capable fake database (has getTableSchema + alterTable).
function migratableDb(overrides: Record<string, unknown> = {}) {
  return {
    getTableSchema: vi.fn(async () => ({ columns: {} })),
    alterTable: vi.fn(async () => {}),
    query: vi.fn(async () => ({ rows: [] })),
    close: vi.fn(),
    ...overrides,
  };
}

vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: h.registry,
  SchemaComparer: class {
    compare = (...a: unknown[]) => h.schemaCompare(...a);
  },
  generateDDLForEngine: vi.fn(() => ({
    createTable: 'CREATE TABLE x ()',
    indexes: [],
    triggers: [],
  })),
  isQualifiedName: vi.fn((s: string) => s.includes(':')),
  getClassName: vi.fn((s: string) => (s.includes(':') ? s.split(':')[1] : s)),
}));

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: (...args: unknown[]) => h.autoDiscoverAndLoad(...args),
}));

vi.mock('@happyvertical/smrt-config', () => ({
  getPackageConfig: (...args: unknown[]) => h.getPackageConfig(...args),
}));

vi.mock('../config.js', () => ({
  DEFAULT_CLI_CONFIG: { database: { type: 'sqlite', url: ':memory:' } },
}));

vi.mock('@happyvertical/sql', () => ({
  getDatabase: (...args: unknown[]) => h.getDatabase(...args),
  clearConnectionCache: (...args: unknown[]) => h.clearConnectionCache(...args),
}));

// schema-contract guards: make them no-ops so handlers proceed.
vi.mock('../schema-contract.js', async () => {
  const actual: any = await vi.importActual('../schema-contract.js');
  return {
    ...actual,
    assertNoUnsupportedMigrationFiles: vi.fn(async () => {}),
    assertSchemaContract: vi.fn(() => {}),
    evaluateSchemaContract: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock('@happyvertical/smrt-core/migrations', () => ({
  MigrationTracker: class {
    initialize = h.trackerInitialize;
    getEngine = h.trackerGetEngine;
    applyAll = h.trackerApplyAll;
  },
  shortChecksum: (s: string) => (s ? s.slice(0, 8) : 'nochk'),
}));

vi.mock('@happyvertical/smrt-core/schema/utils', () => ({
  ensureSchema: (...a: unknown[]) => h.ensureSchema(...a),
  generateSchema: (...a: unknown[]) => h.generateSchema(...a),
}));

vi.mock('@happyvertical/smrt-core/manifest', () => ({
  ManifestBuilder: class {
    generate = (...a: unknown[]) => h.manifestGenerate(...a);
  },
}));

vi.mock('@happyvertical/smrt-core/manifest/discover-base-classes', () => ({
  discoverBaseClasses: (...a: unknown[]) => h.discoverBaseClasses(...a),
}));

vi.mock('node:child_process', () => ({
  spawn: (...a: unknown[]) => h.spawn(...a),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: (...a: unknown[]) => h.rlQuestion(...a),
    close: (...a: unknown[]) => h.rlClose(...a),
  }),
}));

// json-validator used by db:validate
vi.mock('../json-validator.js', () => ({
  resolveDataPath: (...a: unknown[]) => h.resolveDataPath(...a),
  discoverJsonFiles: (...a: unknown[]) => h.discoverJsonFiles(...a),
  displayValidationResults: (...a: unknown[]) =>
    h.displayValidationResults(...a),
  JsonDatabaseValidator: class {
    validate = h.validateFn;
    applyFixes = h.applyFixes;
    generateSummary = h.generateSummary;
  },
}));

import { utilityCommands } from '../utilities.js';

describe('utility command handlers', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as typeof process.exit);

    // defaults
    registry.getAllClasses.mockReturnValue(new Map());
    registry.getInitializationOrder.mockReturnValue([]);
    registry.getAllSchemasAsDefinitions.mockReturnValue([]);
    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
    });
    getDatabase.mockResolvedValue({ close: vi.fn() });
    schemaCompare.mockResolvedValue({ added_tables: [], changes: [] });
    trackerApplyAll.mockResolvedValue([]);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = undefined;
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  const logged = () => logSpy.mock.calls.flat().join('\n');
  const errored = () => errSpy.mock.calls.flat().join('\n');

  // ----------------------------- introspect -----------------------------

  it('introspect reports when no manifests are discovered', async () => {
    autoDiscoverAndLoad.mockResolvedValue({ discovered: [], totalObjects: 0 });
    await utilityCommands.introspect.handler([], {});
    expect(logged()).toContain('No SMRT manifests found');
  });

  it('introspect lists manifests and registered objects in verbose mode', async () => {
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [
        {
          source: 'project',
          packageName: '@app/demo',
          path: '/p/.smrt/manifest.json',
          objectCount: 2,
        },
        {
          source: 'package',
          packageName: undefined,
          path: '/n/manifest.json',
          objectCount: 1,
        },
      ],
      totalObjects: 3,
    });
    registry.getAllClasses.mockReturnValue(
      new Map([
        ['@app/demo:Article', { name: 'Article', fields: { title: {} } }],
      ]),
    );

    await utilityCommands.introspect.handler([], { verbose: true });

    const out = logged();
    expect(out).toContain('Discovered 2 manifest(s)');
    expect(out).toContain('Total objects discovered: 3');
    expect(out).toContain('Registered Objects');
    expect(out).toContain('Article');
  });

  // --------------------------- db:clear-cache ---------------------------

  it('db:clear-cache clears the connection cache', async () => {
    await utilityCommands['db:clear-cache'].handler([], { verbose: true });
    expect(clearConnectionCache).toHaveBeenCalled();
    expect(logged()).toContain('Database connection cache cleared');
    expect(logged()).toContain('JSON data files have been modified');
  });

  it('db:clear-cache reports failures', async () => {
    clearConnectionCache.mockImplementation(() => {
      throw new Error('cache boom');
    });
    await expect(
      utilityCommands['db:clear-cache'].handler([], {}),
    ).rejects.toThrow('exit:1');
    expect(errored()).toContain('Failed to clear cache');
    expect(errored()).toContain('cache boom');
  });

  // ------------------------------ db:setup ------------------------------

  it('db:setup exits when the database is not configured', async () => {
    getPackageConfig.mockReturnValue({ database: { url: ':memory:' } });
    // process.exit() is invoked inside the try block; the thrown sentinel is
    // caught by the handler, which sets exitCode and returns.
    await utilityCommands['db:setup'].handler([], {});
    expect(errored()).toContain('Database configuration required for db:setup');
    expect(process.exitCode).toBe(1);
  });

  it('db:setup exits when no manifests are found', async () => {
    autoDiscoverAndLoad.mockResolvedValue({ discovered: [], totalObjects: 0 });
    await utilityCommands['db:setup'].handler([], {});
    expect(errored()).toContain('No SMRT manifests found');
    expect(process.exitCode).toBe(1);
  });

  // ----------------------------- db:validate ----------------------------

  it('db:validate exits when the data directory cannot be found', async () => {
    resolveDataPath.mockResolvedValue(null);
    await expect(
      utilityCommands['db:validate'].handler([], {}),
    ).rejects.toThrow('exit:1');
    expect(errored()).toContain('Could not find data directory');
  });

  it('db:validate reports when no JSON files are present', async () => {
    resolveDataPath.mockResolvedValue('/data');
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    discoverJsonFiles.mockResolvedValue([]);

    await utilityCommands['db:validate'].handler([], {});
    expect(logged()).toContain('No JSON data files found');
  });

  it('db:validate emits a JSON no-files summary with --json', async () => {
    resolveDataPath.mockResolvedValue('/data');
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    discoverJsonFiles.mockResolvedValue([]);

    await utilityCommands['db:validate'].handler([], { json: true });
    expect(logged()).toContain('"totalFiles": 0');
  });

  it('db:validate runs the validator and displays results', async () => {
    resolveDataPath.mockResolvedValue('/data');
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 2,
    });
    discoverJsonFiles.mockResolvedValue(['/data/a.json']);
    validateFn.mockResolvedValue({ fixableIssues: [] });
    generateSummary.mockReturnValue({ issues: { errors: 0 } });

    await utilityCommands['db:validate'].handler([], {});
    expect(displayValidationResults).toHaveBeenCalled();
  });

  it('db:validate exits non-zero when validation has errors', async () => {
    resolveDataPath.mockResolvedValue('/data');
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    discoverJsonFiles.mockResolvedValue(['/data/a.json']);
    validateFn.mockResolvedValue({ fixableIssues: [] });
    generateSummary.mockReturnValue({ issues: { errors: 3 } });

    await expect(
      utilityCommands['db:validate'].handler([], {}),
    ).rejects.toThrow('exit:1');
  });

  // ------------------------------ db:migrate ----------------------------

  it('db:migrate exits when the database is not configured', async () => {
    getPackageConfig.mockReturnValue({ database: { url: ':memory:' } });
    await utilityCommands['db:migrate'].handler([], {});
    expect(errored()).toContain(
      'Database configuration required for db:migrate',
    );
    expect(process.exitCode).toBe(1);
  });

  it('db:migrate short-circuits for the JSON adapter', async () => {
    getPackageConfig.mockReturnValue({
      database: { type: 'json', url: './data' },
    });
    await utilityCommands['db:migrate'].handler([], {});
    expect(logged()).toContain('JSON adapter has limited migration support');
  });

  it('db:migrate exits when no manifests are found', async () => {
    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
    });
    autoDiscoverAndLoad.mockResolvedValue({ discovered: [], totalObjects: 0 });
    await utilityCommands['db:migrate'].handler([], {});
    expect(errored()).toContain('No SMRT manifests found');
    expect(process.exitCode).toBe(1);
  });

  it('db:migrate reports adapters lacking migration support', async () => {
    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
    });
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    registry.getInitializationOrder.mockReturnValue([]);
    registry.getAllSchemasAsDefinitions.mockReturnValue([]);
    // a db without getTableSchema/alterTable
    getDatabase.mockResolvedValue({ close: vi.fn() });

    await utilityCommands['db:migrate'].handler([], {});
    expect(errored()).toContain('does not support schema migration');
    expect(process.exitCode).toBe(1);
  });

  function configureMigrate() {
    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
    });
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    registry.getInitializationOrder.mockReturnValue(['Article']);
    registry.getTableName.mockReturnValue('contents');
    registry.getTableStrategy.mockReturnValue('cti');
    registry.getClass.mockReturnValue({
      name: 'Article',
      qualifiedName: '@app:Article',
    });
    registry.getAllSchemasAsDefinitions.mockReturnValue([]);
    getDatabase.mockResolvedValue(migratableDb());
  }

  it('db:migrate reports an up-to-date schema when there are no changes', async () => {
    configureMigrate();
    schemaCompare.mockResolvedValue({ added_tables: [], changes: [] });

    await utilityCommands['db:migrate'].handler([], { verbose: true });
    expect(logged()).toContain('Database schema is up to date');
  });

  it('db:migrate previews changes in --dry-run mode', async () => {
    configureMigrate();
    schemaCompare.mockResolvedValue({
      added_tables: [
        {
          tableName: 'widgets',
          columns: { id: { type: 'TEXT' } },
          ddl: 'CREATE TABLE widgets (id TEXT)',
        },
      ],
      changes: [
        {
          type: 'add_column',
          table: 'contents',
          name: 'subtitle',
          column: { type: 'TEXT' },
          sql: 'ALTER TABLE contents ADD COLUMN subtitle TEXT',
        },
        {
          type: 'add_index',
          table: 'contents',
          index: { name: 'idx_contents_status', columns: ['status'] },
          sql: 'CREATE INDEX idx_contents_status ON contents (status)',
        },
      ],
    });

    await utilityCommands['db:migrate'].handler([], {
      'dry-run': true,
      verbose: true,
    });

    const out = logged();
    expect(out).toContain('Migration Preview');
    expect(out).toContain('Would create table');
    expect(out).toContain('SQL Statements');
    // Dry-run never invokes the tracker.
    expect(trackerApplyAll).not.toHaveBeenCalled();
  });

  it('db:migrate applies schema changes through the tracker', async () => {
    configureMigrate();
    schemaCompare.mockResolvedValue({
      added_tables: [],
      changes: [
        {
          type: 'add_column',
          table: 'contents',
          name: 'subtitle',
          column: { type: 'TEXT' },
          sql: 'ALTER TABLE contents ADD COLUMN subtitle TEXT',
        },
      ],
    });
    trackerApplyAll.mockResolvedValue([
      {
        name: 'add_column_contents_subtitle',
        success: true,
        skipped: false,
        applied: true,
        execution_time_ms: 5,
        checksum: 'abc123def',
      },
    ]);

    await utilityCommands['db:migrate'].handler([], {});

    expect(trackerApplyAll).toHaveBeenCalled();
    expect(logged()).toContain('Successfully applied');
  });

  it('db:migrate reports a failed migration batch', async () => {
    configureMigrate();
    schemaCompare.mockResolvedValue({
      added_tables: [],
      changes: [
        {
          type: 'add_column',
          table: 'contents',
          name: 'subtitle',
          column: { type: 'TEXT' },
          sql: 'ALTER TABLE contents ADD COLUMN subtitle TEXT',
        },
      ],
    });
    trackerApplyAll.mockResolvedValue([
      {
        name: 'add_column_contents_subtitle',
        success: false,
        rolled_back: false,
        error: new Error('disk full'),
        execution_time_ms: 1,
        checksum: 'x',
      },
    ]);

    await utilityCommands['db:migrate'].handler([], {});
    expect(errored()).toContain('atomic schema migration failed');
    expect(process.exitCode).toBe(1);
  });

  // ------------------------------ db:setup ------------------------------

  it('db:setup previews DDL in --dry-run mode', async () => {
    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
    });
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    registry.getInitializationOrder.mockReturnValue(['Article']);
    registry.getClass.mockReturnValue({
      name: 'Article',
      qualifiedName: '@app:Article',
      constructor: class Article {},
    });
    registry.getTableStrategy.mockReturnValue('cti');
    registry.getSTIBase.mockReturnValue(null);
    registry.getTableName.mockReturnValue('articles');
    generateSchema.mockResolvedValue('CREATE TABLE articles (id TEXT)');

    await utilityCommands['db:setup'].handler([], {
      'dry-run': true,
      verbose: true,
    });

    const out = logged();
    expect(out).toContain('SQL Preview');
    expect(out).toContain('CREATE TABLE articles');
    expect(out).toContain('Dry-run complete');
  });

  it('db:setup creates tables and reports a summary', async () => {
    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
    });
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    registry.getInitializationOrder.mockReturnValue(['Article']);
    registry.getClass.mockReturnValue({
      name: 'Article',
      qualifiedName: '@app:Article',
      constructor: class Article {},
    });
    registry.getTableStrategy.mockReturnValue('cti');
    registry.getSTIBase.mockReturnValue(null);
    registry.getTableName.mockReturnValue('articles');
    registry.getFields.mockReturnValue(new Map([['title', {}]]));
    ensureSchema.mockResolvedValue(undefined);
    getDatabase.mockResolvedValue(migratableDb());

    await utilityCommands['db:setup'].handler([], { verbose: true });

    expect(ensureSchema).toHaveBeenCalled();
    expect(logged()).toContain('Successfully initialized');
    expect(logged()).toContain('articles');
  });

  it('db:setup skips the destructive --drop flow in non-interactive mode', async () => {
    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
      interactive: false,
    });
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    registry.getInitializationOrder.mockReturnValue(['Article']);
    registry.getClass.mockReturnValue({ name: 'Article' });
    registry.getTableStrategy.mockReturnValue('cti');
    registry.getSTIBase.mockReturnValue(null);
    registry.getTableName.mockReturnValue('articles');
    getDatabase.mockResolvedValue(migratableDb());

    await utilityCommands['db:setup'].handler([], { drop: true });

    expect(errored()).toContain('Cannot use --drop in non-interactive mode');
    expect(process.exitCode).toBe(1);
  });

  it('db:setup drops tables when --drop is confirmed interactively', async () => {
    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
      interactive: true,
    });
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    registry.getInitializationOrder.mockReturnValue(['Article']);
    registry.getClass.mockReturnValue({
      name: 'Article',
      qualifiedName: '@app:Article',
      constructor: class {},
    });
    registry.getTableStrategy.mockReturnValue('cti');
    registry.getSTIBase.mockReturnValue(null);
    registry.getTableName.mockReturnValue('articles');
    registry.getFields.mockReturnValue(new Map([['title', {}]]));
    ensureSchema.mockResolvedValue(undefined);
    rlQuestion.mockResolvedValue('y');
    // tagged-template execute used by the drop loop
    const execute = vi.fn(async () => {});
    getDatabase.mockResolvedValue(migratableDb({ execute }));

    await utilityCommands['db:setup'].handler([], {
      drop: true,
      verbose: true,
    });

    expect(execute).toHaveBeenCalled();
    expect(logged()).toContain('Dropping existing tables');
    expect(logged()).toContain('Successfully initialized');
  });

  it('db:setup aborts the drop flow when the user declines', async () => {
    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
      interactive: true,
    });
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    registry.getInitializationOrder.mockReturnValue(['Article']);
    registry.getClass.mockReturnValue({ name: 'Article' });
    registry.getTableStrategy.mockReturnValue('cti');
    registry.getSTIBase.mockReturnValue(null);
    registry.getTableName.mockReturnValue('articles');
    rlQuestion.mockResolvedValue('n');
    getDatabase.mockResolvedValue(migratableDb({ execute: vi.fn() }));

    await utilityCommands['db:setup'].handler([], { drop: true });

    expect(logged()).toContain('Cancelled by user');
  });

  it('db:setup skips STI child classes that share a parent table', async () => {
    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
    });
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 2,
    });
    registry.getInitializationOrder.mockReturnValue(['Article', 'Page']);
    registry.getTableStrategy.mockReturnValue('sti');
    registry.getClass.mockImplementation((name: string) => ({
      name,
      qualifiedName: `@app:${name}`,
      constructor: class {},
    }));
    registry.getSTIBase.mockImplementation((name: string) =>
      name === 'Page' ? '@app:Article' : '@app:Article',
    );
    registry.getTableName.mockReturnValue('contents');
    registry.getFields.mockReturnValue(new Map([['title', {}]]));
    ensureSchema.mockResolvedValue(undefined);
    getDatabase.mockResolvedValue(migratableDb());

    await utilityCommands['db:setup'].handler([], { verbose: true });

    expect(logged()).toContain('shares table with');
  });

  it('db:setup surfaces ensureSchema failures per class', async () => {
    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
    });
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    registry.getInitializationOrder.mockReturnValue(['Article']);
    registry.getClass.mockReturnValue({
      name: 'Article',
      qualifiedName: '@app:Article',
      constructor: class {},
    });
    registry.getTableStrategy.mockReturnValue('cti');
    registry.getSTIBase.mockReturnValue(null);
    registry.getTableName.mockReturnValue('articles');
    ensureSchema.mockRejectedValue(new Error('ddl error'));
    getDatabase.mockResolvedValue(migratableDb());

    await utilityCommands['db:setup'].handler([], { verbose: true });

    expect(errored()).toContain('ddl error');
  });

  // ------------------------- db:migrate (extended) ----------------------

  it('db:migrate creates new tables atomically', async () => {
    configureMigrate();
    schemaCompare.mockResolvedValue({
      added_tables: [
        {
          tableName: 'widgets',
          columns: { id: { type: 'TEXT' } },
          ddl: 'CREATE TABLE widgets (id TEXT)',
        },
      ],
      changes: [],
    });
    trackerApplyAll.mockResolvedValue([
      {
        name: 'create_table_widgets',
        success: true,
        skipped: false,
        applied: true,
        execution_time_ms: 7,
        checksum: 'chk12345',
      },
    ]);

    await utilityCommands['db:migrate'].handler([], {});

    expect(trackerApplyAll).toHaveBeenCalled();
    expect(logged()).toContain('Successfully applied');
  });

  it('db:migrate reports manual-intervention drift', async () => {
    configureMigrate();
    schemaCompare.mockResolvedValue({
      added_tables: [],
      changes: [
        {
          type: 'type_mismatch',
          table: 'contents',
          name: 'count',
          mismatch: { expected: 'BIGINT', actual: 'INTEGER' },
        },
      ],
    });

    await utilityCommands['db:migrate'].handler([], {});

    const out = logged();
    expect(out).toContain('requires manual intervention');
    expect(out).toContain('contents.count');
    // manual intervention should drive a non-zero exit
    expect(process.exitCode).toBe(1);
  });

  it('db:migrate verbose lists STI child tables', async () => {
    configureMigrate();
    registry.getInitializationOrder.mockReturnValue(['Article', 'Page']);
    registry.getTableStrategy.mockReturnValue('sti');
    registry.getTableName.mockImplementation((name: string) =>
      name === 'Article' ? 'contents' : 'contents',
    );
    registry.getSTIBase.mockImplementation((name: string) =>
      name === 'Page' ? '@app:Article' : null,
    );
    registry.getClass.mockImplementation((name: string) => ({
      name,
      qualifiedName: `@app:${name}`,
    }));

    await utilityCommands['db:migrate'].handler([], { verbose: true });

    expect(logged()).toContain('Tables to check');
  });

  it('db:migrate runs the STI discriminator repair with --repair-data', async () => {
    configureMigrate();
    registry.getInitializationOrder.mockReturnValue(['Article']);
    registry.getTableName.mockReturnValue('contents');
    schemaCompare.mockResolvedValue({ added_tables: [], changes: [] });
    // A db whose STI table reports a _meta_type column plus rows to inspect.
    getDatabase.mockResolvedValue(
      migratableDb({
        getTableSchema: vi.fn(async () => ({
          columns: { _meta_type: { type: 'TEXT' } },
        })),
        query: vi.fn(async () => ({ rows: [] })),
      }),
    );

    await utilityCommands['db:migrate'].handler([], { 'repair-data': true });

    expect(logged()).toContain('Repairing STI discriminators');
  });

  it('db:migrate builds migration defs for index and type-upgrade changes', async () => {
    configureMigrate();
    schemaCompare.mockResolvedValue({
      added_tables: [],
      changes: [
        {
          type: 'add_index',
          table: 'contents',
          index: { name: 'idx_status', columns: ['status'] },
          sql: 'CREATE INDEX idx_status ON contents (status)',
        },
        {
          type: 'type_upgrade',
          table: 'contents',
          name: 'count',
          column: { type: 'BIGINT' },
          mismatch: { expected: 'BIGINT', actual: 'INTEGER' },
          sql: 'ALTER TABLE contents ALTER COLUMN count TYPE BIGINT',
        },
      ],
    });
    trackerApplyAll.mockResolvedValue([
      {
        name: 'add_index_idx_status_abc',
        success: true,
        applied: true,
        execution_time_ms: 2,
        checksum: 'c1',
      },
      {
        name: 'type_upgrade_contents_count',
        success: true,
        applied: true,
        execution_time_ms: 3,
        checksum: 'c2',
      },
    ]);

    await utilityCommands['db:migrate'].handler([], { verbose: true });
    expect(trackerApplyAll).toHaveBeenCalled();
    expect(logged()).toContain('Successfully applied');
  });

  it('db:migrate dry-run reports the STI repair preview with --repair-data', async () => {
    configureMigrate();
    registry.getInitializationOrder.mockReturnValue(['Article']);
    registry.getTableName.mockReturnValue('contents');
    registry.findClassesByName.mockReturnValue([
      { qualifiedName: '@app:Article' },
    ]);
    registry.getConflictColumns.mockReturnValue(['slug']);
    schemaCompare.mockResolvedValue({ added_tables: [], changes: [] });

    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ _meta_type: 'Article' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'r1', slug: 'x' }] })
      .mockResolvedValueOnce({ rows: [] });

    getDatabase.mockResolvedValue(
      migratableDb({
        getTableSchema: vi.fn(async () => ({
          columns: { _meta_type: { type: 'TEXT' } },
        })),
        query,
      }),
    );

    await utilityCommands['db:migrate'].handler([], {
      'dry-run': true,
      'repair-data': true,
    });

    expect(logged()).toContain('Repairing STI discriminators');
    expect(logged()).toContain('DRY RUN');
  });

  it('db:migrate upgrades legacy STI discriminators with --repair-data', async () => {
    configureMigrate();
    registry.getInitializationOrder.mockReturnValue(['Article']);
    registry.getTableName.mockReturnValue('contents');
    registry.findClassesByName.mockReturnValue([
      { qualifiedName: '@app:Article' },
    ]);
    registry.getConflictColumns.mockReturnValue(['slug']);
    schemaCompare.mockResolvedValue({ added_tables: [], changes: [] });

    // Drive the query stack: DISTINCT _meta_type -> legacy unqualified name;
    // legacy-row SELECT -> one row; duplicate-check -> none; UPDATE -> rowCount.
    const query = vi
      .fn()
      // SELECT DISTINCT _meta_type ...
      .mockResolvedValueOnce({ rows: [{ _meta_type: 'Article' }] })
      // SELECT id, slug ... WHERE _meta_type = legacy
      .mockResolvedValueOnce({ rows: [{ id: 'r1', slug: 'hello' }] })
      // duplicate check -> none
      .mockResolvedValueOnce({ rows: [] })
      // UPDATE -> rowCount
      .mockResolvedValueOnce({ rowCount: 1 });

    getDatabase.mockResolvedValue(
      migratableDb({
        getTableSchema: vi.fn(async () => ({
          columns: { _meta_type: { type: 'TEXT' } },
        })),
        query,
      }),
    );

    await utilityCommands['db:migrate'].handler([], { 'repair-data': true });

    const out = logged();
    expect(out).toContain('Repairing STI discriminators');
    expect(out).toContain('Successfully repaired');
  });

  it('db:migrate warns that --upgrade-sti is deprecated', async () => {
    configureMigrate();
    registry.getInitializationOrder.mockReturnValue(['Article']);
    registry.getTableName.mockReturnValue('contents');
    getDatabase.mockResolvedValue(
      migratableDb({
        getTableSchema: vi.fn(async () => ({ columns: {} })),
      }),
    );

    await utilityCommands['db:migrate'].handler([], { 'upgrade-sti': true });

    expect(warnSpy.mock.calls.flat().join('\n')).toContain(
      '--upgrade-sti is deprecated',
    );
  });

  // ------------------------------- test ---------------------------------

  it('test command generates a manifest with --manifest-only', async () => {
    const dir = await mkdtemp(resolve(process.cwd(), '.tmp-test-cmd-'));
    tempDirs.push(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      manifestGenerate.mockResolvedValue({ objects: { '@app:Article': {} } });
      discoverBaseClasses.mockResolvedValue(['B1', 'B2', 'B3', 'B4']);

      await utilityCommands.test.handler([], { manifestOnly: true });

      const out = logged();
      expect(out).toContain('DEPRECATED');
      expect(out).toContain('Generated test manifest');
      expect(manifestGenerate).toHaveBeenCalled();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('test command runs vitest after generating the manifest', async () => {
    const dir = await mkdtemp(resolve(process.cwd(), '.tmp-test-run-'));
    tempDirs.push(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      manifestGenerate.mockResolvedValue({ objects: { '@app:Article': {} } });
      discoverBaseClasses.mockResolvedValue(['B1', 'B2', 'B3']);
      // a fake child process that immediately closes with success
      spawn.mockReturnValue({
        on: (event: string, cb: (code?: number) => void) => {
          if (event === 'close') cb(0);
        },
      });

      await utilityCommands.test.handler([], {});

      expect(spawn).toHaveBeenCalled();
      expect(logged()).toContain('Running tests');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('test command reports manifest generation failures', async () => {
    const dir = await mkdtemp(resolve(process.cwd(), '.tmp-test-cmd-fail-'));
    tempDirs.push(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      discoverBaseClasses.mockResolvedValue(['B1', 'B2', 'B3']);
      manifestGenerate.mockRejectedValue(new Error('scan failed'));

      await expect(
        utilityCommands.test.handler([], { manifestOnly: true }),
      ).rejects.toThrow('exit:1');
      expect(errored()).toContain('Failed to generate test manifest');
      expect(errored()).toContain('scan failed');
    } finally {
      process.chdir(originalCwd);
    }
  });

  // --------------------------- db:validate fix --------------------------

  it('db:validate applies fixes when --fix is set', async () => {
    resolveDataPath.mockResolvedValue('/data');
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    discoverJsonFiles.mockResolvedValue(['/data/a.json']);
    validateFn.mockResolvedValue({ fixableIssues: [{ id: 'x' }] });
    applyFixes.mockResolvedValue(1);
    generateSummary.mockReturnValue({ issues: { errors: 0 } });

    await utilityCommands['db:validate'].handler([], { fix: true });

    expect(applyFixes).toHaveBeenCalledWith([{ id: 'x' }]);
    expect(logged()).toContain('Fixed 1 issue');
  });

  it('db:validate emits a JSON summary with --json', async () => {
    resolveDataPath.mockResolvedValue('/data');
    autoDiscoverAndLoad.mockResolvedValue({
      discovered: [{ path: '/p' }],
      totalObjects: 1,
    });
    discoverJsonFiles.mockResolvedValue(['/data/a.json']);
    validateFn.mockResolvedValue({ fixableIssues: [] });
    generateSummary.mockReturnValue({ issues: { errors: 0 }, totalFiles: 1 });

    await utilityCommands['db:validate'].handler([], { json: true });
    expect(logged()).toContain('"totalFiles": 1');
    expect(displayValidationResults).not.toHaveBeenCalled();
  });

  it('db:validate generates a manifest on the fly when none are found', async () => {
    resolveDataPath.mockResolvedValue('/data');
    autoDiscoverAndLoad.mockResolvedValue({ discovered: [], totalObjects: 0 });
    discoverJsonFiles.mockResolvedValue(['/data/a.json']);
    manifestGenerate.mockResolvedValue({ objects: {} });
    discoverBaseClasses.mockResolvedValue(['B1', 'B2', 'B3']);
    validateFn.mockResolvedValue({ fixableIssues: [] });
    generateSummary.mockReturnValue({ issues: { errors: 0 } });

    await utilityCommands['db:validate'].handler([], {});

    expect(manifestGenerate).toHaveBeenCalled();
    expect(logged()).toContain('Generated manifest from source files');
  });

  it('db:validate reports failures and exits', async () => {
    resolveDataPath.mockRejectedValue(new Error('fs boom'));
    await expect(
      utilityCommands['db:validate'].handler([], {}),
    ).rejects.toThrow('exit:1');
    expect(errored()).toContain('Validation failed');
  });
});
