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
  MockMigrationTracker,
  MockSchemaComparer,
  trackerOptions,
  transactionRolledBack,
} = vi.hoisted(() => {
  const migrationAttempts: string[] = [];
  const migrationApplyAllOptions: Array<{
    atomic?: boolean;
    force?: boolean;
    postgresSafe?: boolean;
    reconcile?: boolean;
  }> = [];
  const committedAppliedMigrations: string[] = [];
  const trackerOptions: Array<{ useConcurrentIndexes?: boolean }> = [];
  const transactionRolledBack = { value: false };

  class MockSchemaComparer {
    compare = compareMock;
  }

  class MockMigrationTracker {
    private db: any;

    constructor(options: { db: any; useConcurrentIndexes?: boolean }) {
      this.db = options.db;
      trackerOptions.push({
        useConcurrentIndexes: options.useConcurrentIndexes,
      });
    }

    async initialize() {}

    getEngine() {
      return 'postgres';
    }

    async applyAll(
      definitions: Array<{ id: string }>,
      options: {
        atomic?: boolean;
        force?: boolean;
        onProgress?: (result: any) => void;
        postgresSafe?: boolean;
        reconcile?: boolean;
      } = {},
    ) {
      migrationApplyAllOptions.push({
        atomic: options.atomic,
        force: options.force,
        postgresSafe: options.postgresSafe,
        reconcile: options.reconcile,
      });

      const results: any[] = [];
      let failedName: string | undefined;

      try {
        await this.db.transaction(async (tx: any) => {
          for (const definition of definitions) {
            migrationAttempts.push(definition.id);

            if (definition.id === 'add_column_contents_second_column') {
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
  isQualifiedName: vi.fn((value: string) => value.includes(':')),
}));

vi.mock('@happyvertical/smrt-core/migrations', () => ({
  MigrationTracker: MockMigrationTracker,
  shortChecksum: vi.fn((checksum: string) => checksum),
}));

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
        postgresSafe: false,
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

  it('warns when postgres-safe index operations are folded into the atomic batch', async () => {
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
          sql: 'CREATE INDEX "contents_first_column_idx" ON "contents" ("first_column")',
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

    expect(warnSpy.mock.calls.flat().join('\n')).toContain(
      '--postgres-safe requested',
    );
    expect(migrationAttempts).toEqual([
      expect.stringMatching(/^add_index_contents_first_column_idx_/),
    ]);
    expect(migrationApplyAllOptions[0]).toMatchObject({
      atomic: true,
      postgresSafe: false,
      reconcile: true,
    });
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('atomic schema migration failed'),
    );
    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      'Created index contents_first_column_idx on contents',
    );
  }, 15_000);
});
