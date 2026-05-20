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
  migrationAttempts,
  MockMigrationTracker,
  MockSchemaComparer,
  trackerOptions,
  transactionRolledBack,
} = vi.hoisted(() => {
  const migrationAttempts: string[] = [];
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

    async apply(definition: { id: string }) {
      migrationAttempts.push(definition.id);

      if (definition.id === 'add_column_contents_second_column') {
        return {
          success: false,
          applied: false,
          skipped: false,
          name: definition.id,
          checksum: 'bad',
          execution_time_ms: 1,
          error: new Error('synthetic failure'),
        };
      }

      this.db.appliedMigrations.push(definition.id);
      return {
        success: true,
        applied: true,
        skipped: false,
        name: definition.id,
        checksum: 'ok',
        execution_time_ms: 1,
      };
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

    await utilityCommands['db:migrate'].handler([], { 'postgres-safe': true });

    expect(migrationAttempts).toEqual([
      'add_column_contents_first_column',
      'add_column_contents_second_column',
    ]);
    expect(transactionRolledBack.value).toBe(true);
    expect(committedAppliedMigrations).toEqual([]);
    expect(
      trackerOptions.map((options) => options.useConcurrentIndexes),
    ).toEqual([true, false]);
    expect(process.exitCode).toBe(1);

    const stdout = logSpy.mock.calls.flat().join('\n');
    const stderr = errorSpy.mock.calls.flat().join('\n');
    expect(stdout).not.toContain('Added column contents.first_column');
    expect(stderr).toContain('atomic schema migration failed');
    expect(stderr).toContain('Rolled back all schema changes');
  });
});
