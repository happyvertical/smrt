import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  autoDiscoverAndLoadMock,
  committedAppliedMigrations,
  compareMock,
  getAllSchemasAsDefinitionsMock,
  getDatabaseMock,
  getInitializationOrderMock,
  getPackageConfigMock,
  getTableNameMock,
  migrationApplyAllOptions,
  migrationAttempts,
  planForeignKeyCreationMock,
  MockMigrationTracker,
  MockSchemaComparer,
  trackerOptions,
  transactionRolledBack,
} = vi.hoisted(() => {
  const migrationAttempts: string[] = [];
  const migrationApplyAllOptions: Array<{
    atomic?: boolean;
    force?: boolean;
    forceMigrations?: readonly string[];
    postgresSafe?: boolean;
    reconcile?: boolean;
  }> = [];
  const committedAppliedMigrations: string[] = [];
  const trackerOptions: Array<{
    lockTimeout?: number;
    statementTimeout?: number;
    useConcurrentIndexes?: boolean;
  }> = [];
  const transactionRolledBack = { value: false };

  class MockSchemaComparer {
    compare = compareMock;
  }

  class MockMigrationTracker {
    private db: any;

    constructor(options: {
      db: any;
      lockTimeout?: number;
      statementTimeout?: number;
      useConcurrentIndexes?: boolean;
    }) {
      this.db = options.db;
      trackerOptions.push({
        lockTimeout: options.lockTimeout,
        statementTimeout: options.statementTimeout,
        useConcurrentIndexes: options.useConcurrentIndexes,
      });
    }

    async initialize() {}

    getEngine() {
      return 'postgres';
    }

    async applyAll(
      definitions: Array<{ id: string; up?: string[] }>,
      options: {
        atomic?: boolean;
        force?: boolean;
        forceMigrations?: readonly string[];
        onProgress?: (result: any) => void;
        postgresSafe?: boolean;
        reconcile?: boolean;
      } = {},
    ) {
      migrationApplyAllOptions.push({
        atomic: options.atomic,
        force: options.force,
        forceMigrations: options.forceMigrations,
        postgresSafe: options.postgresSafe,
        reconcile: options.reconcile,
      });

      const results: any[] = [];
      let failedName: string | undefined;

      try {
        await this.db.transaction(async (tx: any) => {
          for (const definition of definitions) {
            migrationAttempts.push(definition.id);

            if (
              definition.id === 'add_column_contents_second_column' ||
              definition.up?.some((sql) =>
                sql.includes('synthetic_deferred_failure'),
              )
            ) {
              failedName = definition.id;
              const failed = {
                success: false,
                applied: false,
                skipped: false,
                name: definition.id,
                checksum: 'bad',
                execution_time_ms: 1,
                error: new Error('synthetic failure'),
              };
              results.push(failed);
              options.onProgress?.(failed);
              throw failed.error;
            }

            tx.appliedMigrations.push(definition.id);
            const result = {
              success: true,
              applied: true,
              skipped: false,
              name: definition.id,
              checksum: 'ok',
              execution_time_ms: 1,
            };
            results.push(result);
            options.onProgress?.(result);
          }
        });
      } catch {
        return results.map((result) =>
          result.success
            ? {
                ...result,
                success: false,
                applied: false,
                skipped: false,
                rolled_back: true,
                error: new Error(
                  `Rolled back because migration ${failedName} failed`,
                ),
              }
            : result,
        );
      }

      return results;
    }
  }

  const compareMock = vi.fn();

  return {
    autoDiscoverAndLoadMock: vi.fn(),
    committedAppliedMigrations,
    compareMock,
    getAllSchemasAsDefinitionsMock: vi.fn(),
    getDatabaseMock: vi.fn(),
    getInitializationOrderMock: vi.fn(),
    getPackageConfigMock: vi.fn(),
    getTableNameMock: vi.fn(),
    migrationApplyAllOptions,
    migrationAttempts,
    planForeignKeyCreationMock: vi.fn((schemas: unknown[]) => ({
      schemas,
      deferredStatements: [],
    })),
    transactionRolledBack,
    MockMigrationTracker,
    MockSchemaComparer,
    trackerOptions,
  };
});

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: autoDiscoverAndLoadMock,
}));

vi.mock('@happyvertical/smrt-config', () => ({
  getPackageConfig: getPackageConfigMock,
}));

vi.mock('@happyvertical/sql', () => ({
  getDatabase: getDatabaseMock,
}));

vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: {
    getAllSchemasAsDefinitions: getAllSchemasAsDefinitionsMock,
    getInitializationOrder: getInitializationOrderMock,
    getSTIBase: vi.fn(),
    getTableName: getTableNameMock,
    getTableStrategy: vi.fn(() => 'cti'),
  },
  SchemaComparer: MockSchemaComparer,
  generateDDLForEngine: vi.fn((schema: { tableName: string }) => ({
    createTable: `CREATE TABLE "${schema.tableName}" ("id" TEXT PRIMARY KEY)`,
    indexes: [],
    triggers: [],
  })),
  planForeignKeyCreation: planForeignKeyCreationMock,
  isQualifiedName: vi.fn((value: string) => value.includes(':')),
}));

vi.mock('@happyvertical/smrt-core/migrations', async () => {
  // The timeout parser is pure and is the contract under test here, so use the
  // real implementation rather than a stub that could drift from it.
  const actual = await vi.importActual<
    typeof import('@happyvertical/smrt-core/migrations')
  >('@happyvertical/smrt-core/migrations');

  return {
    buildConcurrentIndexPlan: actual.buildConcurrentIndexPlan,
    MigrationTracker: MockMigrationTracker,
    parsePostgresTimeoutMs: actual.parsePostgresTimeoutMs,
    shortChecksum: vi.fn((checksum: string) => checksum),
  };
});

describe('db:migrate atomic schema execution', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
    migrationApplyAllOptions.length = 0;
    migrationAttempts.length = 0;
    committedAppliedMigrations.length = 0;
    trackerOptions.length = 0;
    transactionRolledBack.value = false;
    planForeignKeyCreationMock.mockImplementation((schemas: unknown[]) => ({
      schemas,
      deferredStatements: [],
    }));

    getPackageConfigMock.mockReturnValue({
      database: {
        type: 'postgres',
        url: 'postgresql://test:test@localhost:5432/test_db',
      },
    });

    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [
        {
          path: '/tmp/project/.smrt/manifest.json',
          source: 'project',
          objectCount: 1,
        },
      ],
      totalObjects: 1,
    });

    getInitializationOrderMock.mockReturnValue(['Content']);
    getTableNameMock.mockReturnValue('contents');
    getAllSchemasAsDefinitionsMock.mockReturnValue({
      contents: { tableName: 'contents' },
    });
    compareMock.mockResolvedValue({
      added_tables: [],
      dropped_tables: [],
      has_changes: true,
      changes: [
        {
          type: 'add_column',
          table: 'contents',
          name: 'first_column',
          column: { type: 'TEXT' },
          sql: 'ALTER TABLE "contents" ADD COLUMN "first_column" TEXT',
        },
        {
          type: 'add_column',
          table: 'contents',
          name: 'second_column',
          column: { type: 'TEXT' },
          sql: 'ALTER TABLE "contents" ADD COLUMN "second_column" TEXT',
        },
      ],
    });

    getDatabaseMock.mockResolvedValue({
      url: 'postgresql://test:test@localhost:5432/test_db',
      alterTable: {},
      getTableSchema: vi.fn(),
      close: vi.fn(),
      transaction: async (callback: (tx: any) => Promise<void>) => {
        const tx = {
          appliedMigrations: [] as string[],
          query: vi.fn(),
          tableExists: vi.fn(),
          url: 'postgresql://test:test@localhost:5432/test_db',
        };

        try {
          await callback(tx);
          committedAppliedMigrations.push(...tx.appliedMigrations);
        } catch (error) {
          transactionRolledBack.value = true;
          throw error;
        }
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls back earlier generated migrations when a later generated migration fails', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { utilityCommands } = await import('../utilities.js');

    await utilityCommands['db:migrate'].handler([], {
      'postgres-safe': true,
    });

    expect(migrationAttempts).toEqual([
      'add_column_contents_first_column',
      'add_column_contents_second_column',
    ]);
    expect(transactionRolledBack.value).toBe(true);
    expect(committedAppliedMigrations).toEqual([]);
    expect(
      trackerOptions.map((options) => options.useConcurrentIndexes),
    ).toEqual([true]);
    expect(migrationApplyAllOptions).toEqual([
      {
        atomic: true,
        force: false,
        forceMigrations: undefined,
        // --postgres-safe now actually reaches the tracker (issue #2362).
        postgresSafe: true,
        reconcile: true,
      },
    ]);
    expect(process.exitCode).toBe(1);

    const stdout = logSpy.mock.calls.flat().join('\n');
    const stderr = errorSpy.mock.calls.flat().join('\n');
    expect(stdout).toContain('Added column contents.first_column');
    expect(stderr).toContain('atomic schema migration failed');
    expect(stderr).toContain(
      'add_column_contents_second_column: synthetic failure',
    );
    expect(stderr).toContain('successful steps shown above');
  }, 15_000);

  it('rolls back new tables when a deferred cycle constraint fails in the same batch', async () => {
    compareMock.mockResolvedValue({
      added_tables: [
        { tableName: 'left_nodes', columns: { id: { type: 'TEXT' } } },
        { tableName: 'right_nodes', columns: { id: { type: 'TEXT' } } },
      ],
      dropped_tables: [],
      has_changes: true,
      changes: [],
    });
    planForeignKeyCreationMock.mockReturnValue({
      schemas: [
        { tableName: 'left_nodes', columns: { id: { type: 'TEXT' } } },
        { tableName: 'right_nodes', columns: { id: { type: 'TEXT' } } },
      ],
      deferredStatements: [
        'ALTER TABLE "left_nodes" ADD CONSTRAINT "left_nodes_right_id_fkey" FOREIGN KEY ("right_id") REFERENCES "right_nodes" ("id"); -- synthetic_deferred_failure',
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { utilityCommands } = await import('../utilities.js');

    await utilityCommands['db:migrate'].handler([], {});

    expect(migrationAttempts.slice(0, 2)).toEqual([
      'create_table_left_nodes',
      'create_table_right_nodes',
    ]);
    expect(migrationAttempts[2]).toMatch(/^add_foreign_key_left_nodes_/);
    expect(transactionRolledBack.value).toBe(true);
    expect(committedAppliedMigrations).toEqual([]);
    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      'Applying 3 schema change(s) atomically',
    );
    expect(errorSpy.mock.calls.flat().join('\n')).toContain(
      'atomic schema migration failed',
    );
  }, 15_000);

  it('passes an exact force target into the atomic migration batch', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { utilityCommands } = await import('../utilities.js');

    await utilityCommands['db:migrate'].handler([], {
      'force-migration': 'add_column_contents_first_column',
    });

    expect(migrationApplyAllOptions[0]).toMatchObject({
      atomic: true,
      force: false,
      forceMigrations: ['add_column_contents_first_column'],
      postgresSafe: false,
      reconcile: true,
    });
  }, 15_000);

  it('passes multiple exact force targets into one atomic migration batch', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { utilityCommands } = await import('../utilities.js');

    await utilityCommands['db:migrate'].handler([], {
      'force-migration': [
        'add_column_contents_first_column',
        'add_column_contents_second_column',
      ],
    });

    expect(migrationApplyAllOptions).toHaveLength(1);
    expect(migrationApplyAllOptions[0]).toMatchObject({
      atomic: true,
      force: false,
      forceMigrations: [
        'add_column_contents_first_column',
        'add_column_contents_second_column',
      ],
      postgresSafe: false,
      reconcile: true,
    });
  }, 15_000);

  it('rejects an exact force target outside the current generated batch', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { utilityCommands } = await import('../utilities.js');

    await utilityCommands['db:migrate'].handler([], {
      'force-migration': ['add_column_contents_missing_column'],
    });

    expect(migrationApplyAllOptions).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain(
      'add_column_contents_missing_column',
    );
  }, 15_000);

  it('warns that concurrent-index mode is not atomic and routes the flag through (issue #2362)', async () => {
    compareMock.mockResolvedValue({
      added_tables: [],
      dropped_tables: [],
      has_changes: true,
      changes: [
        {
          type: 'add_index',
          table: 'contents',
          index: {
            name: 'contents_first_column_idx',
            columns: ['first_column'],
          },
          sql: 'CREATE INDEX IF NOT EXISTS "contents_first_column_idx" ON "contents" ("first_column")',
        },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { utilityCommands } = await import('../utilities.js');

    await utilityCommands['db:migrate'].handler([], {
      'postgres-safe': true,
    });

    const warnings = warnSpy.mock.calls.flat().join('\n');
    expect(warnings).toContain('concurrent-index mode');
    expect(warnings).toContain('NOT atomic');
    expect(migrationAttempts).toEqual([
      expect.stringMatching(/^add_index_contents_first_column_idx_/),
    ]);
    expect(migrationApplyAllOptions[0]).toMatchObject({
      atomic: true,
      postgresSafe: true,
      reconcile: true,
    });
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('atomic schema migration failed'),
    );
    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      'Created index contents_first_column_idx on contents',
    );
  }, 15_000);

  it('does not enable concurrent-index mode without --postgres-safe', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { utilityCommands } = await import('../utilities.js');

    await utilityCommands['db:migrate'].handler([], {});

    expect(trackerOptions[0].useConcurrentIndexes).toBe(false);
    expect(migrationApplyAllOptions[0]).toMatchObject({ postgresSafe: false });
  }, 15_000);

  it('passes the configured PostgreSQL timeouts into the tracker (issue #2362)', async () => {
    // `migrations.postgres.lockTimeout` / `.statementTimeout` were previously
    // read by nothing, so every production migration ran unbounded.
    getPackageConfigMock.mockReturnValue({
      database: {
        type: 'postgres',
        url: 'postgresql://test:test@localhost:5432/test_db',
      },
      migrations: {
        postgres: {
          useConcurrently: true,
          lockTimeout: '5s',
          statementTimeout: '2min',
        },
      },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { utilityCommands } = await import('../utilities.js');

    await utilityCommands['db:migrate'].handler([], {});

    expect(trackerOptions[0]).toMatchObject({
      lockTimeout: 5000,
      statementTimeout: 120_000,
    });
  }, 15_000);

  it('defaults the PostgreSQL timeouts when no migrations config exists', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { utilityCommands } = await import('../utilities.js');

    await utilityCommands['db:migrate'].handler([], {});

    expect(trackerOptions[0]).toMatchObject({
      lockTimeout: 30_000,
      statementTimeout: 60_000,
    });
  }, 15_000);

  it('lets migrations.postgres.useConcurrently = false veto --postgres-safe', async () => {
    getPackageConfigMock.mockReturnValue({
      database: {
        type: 'postgres',
        url: 'postgresql://test:test@localhost:5432/test_db',
      },
      migrations: { postgres: { useConcurrently: false } },
    });
    compareMock.mockResolvedValue({
      added_tables: [],
      dropped_tables: [],
      has_changes: true,
      changes: [
        {
          type: 'add_index',
          table: 'contents',
          index: {
            name: 'contents_first_column_idx',
            columns: ['first_column'],
          },
          sql: 'CREATE INDEX IF NOT EXISTS "contents_first_column_idx" ON "contents" ("first_column")',
        },
      ],
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { utilityCommands } = await import('../utilities.js');

    await utilityCommands['db:migrate'].handler([], {
      'postgres-safe': true,
    });

    expect(trackerOptions[0].useConcurrentIndexes).toBe(false);
    expect(migrationApplyAllOptions[0]).toMatchObject({ postgresSafe: false });
    expect(warnSpy.mock.calls.flat().join('\n')).toContain(
      'useConcurrently is false',
    );
  }, 15_000);
});
