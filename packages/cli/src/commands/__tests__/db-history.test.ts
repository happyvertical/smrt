import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  autoDiscoverAndLoadMock,
  getPackageConfigMock,
  getDatabaseMock,
  getAllSchemasAsDefinitionsMock,
  compareMock,
  initializeMock,
  getHistoryMock,
  SchemaComparerMock,
  MigrationTrackerMock,
} = vi.hoisted(() => {
  const compare = vi.fn();
  const initialize = vi.fn();
  const getHistory = vi.fn();

  class MockSchemaComparer {
    compare = compare;
  }

  class MockMigrationTracker {
    initialize = initialize;
    getHistory = getHistory;
  }

  return {
    autoDiscoverAndLoadMock: vi.fn(),
    getPackageConfigMock: vi.fn(),
    getDatabaseMock: vi.fn(),
    getAllSchemasAsDefinitionsMock: vi.fn(),
    compareMock: compare,
    initializeMock: initialize,
    getHistoryMock: getHistory,
    SchemaComparerMock: MockSchemaComparer,
    MigrationTrackerMock: MockMigrationTracker,
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
  },
  SchemaComparer: SchemaComparerMock,
}));

vi.mock('@happyvertical/smrt-core/migrations', () => ({
  MigrationTracker: MigrationTrackerMock,
}));

import { dbHistoryCommand } from '../db-history.js';

describe('db:history', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getPackageConfigMock.mockReturnValue({
      database: {
        type: 'postgres',
        url: 'postgresql://test:test@localhost:5432/test_db',
      },
    });

    getDatabaseMock.mockResolvedValue({
      url: 'postgresql://test:test@localhost:5432/test_db',
      getTableSchema: vi.fn(),
    });

    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [{ path: '/fake/manifest.json' }],
      totalObjects: 3,
    });

    getAllSchemasAsDefinitionsMock.mockReturnValue({
      contents: {
        tableName: 'contents',
      },
    });

    initializeMock.mockResolvedValue(undefined);
    compareMock.mockResolvedValue({
      added_tables: [],
      dropped_tables: [],
      has_changes: true,
      changes: [
        {
          type: 'add_column',
          table: 'contents',
          name: 'script_text',
          column: { type: 'TEXT' },
        },
      ],
    });
    getHistoryMock.mockResolvedValue([
      {
        id: '1',
        name: 'add_column_contents_script_text',
        version: '0.21.45',
        checksum: 'a'.repeat(64),
        applied_checksum: null,
        applied_at: new Date('2026-04-10T00:00:00Z'),
        execution_time_ms: 12,
        status: 'failed',
        error_message: 'column missing',
        attempts: 1,
        is_reversible: false,
        rolled_back_at: null,
        applied_by: 'ci',
        batch: 1,
        package_name: '@happyvertical/smrt-cli',
        source_file: null,
      },
      {
        id: '2',
        name: 'add_index_idx_contents_published_at',
        version: '0.21.44',
        checksum: 'b'.repeat(64),
        applied_checksum: null,
        applied_at: new Date('2026-04-09T00:00:00Z'),
        execution_time_ms: 10,
        status: 'failed',
        error_message: 'index already exists',
        attempts: 1,
        is_reversible: false,
        rolled_back_at: null,
        applied_by: 'ci',
        batch: 1,
        package_name: '@happyvertical/smrt-cli',
        source_file: null,
      },
      {
        id: '3',
        name: 'type_upgrade_contents_status',
        version: '0.21.45',
        checksum: 'c'.repeat(64),
        applied_checksum: null,
        applied_at: new Date('2026-04-08T00:00:00Z'),
        execution_time_ms: 8,
        status: 'failed',
        error_message: 'cannot cast',
        attempts: 1,
        is_reversible: false,
        rolled_back_at: null,
        applied_by: 'ci',
        batch: 1,
        package_name: '@happyvertical/smrt-cli',
        source_file: null,
      },
      {
        id: '4',
        name: 'baseline_schema',
        version: '0.21.45',
        checksum: 'd'.repeat(64),
        applied_checksum: 'd'.repeat(64),
        applied_at: new Date('2026-04-07T00:00:00Z'),
        execution_time_ms: 50,
        status: 'completed',
        error_message: null,
        attempts: 1,
        is_reversible: true,
        rolled_back_at: null,
        applied_by: 'ci',
        batch: 1,
        package_name: '@happyvertical/smrt-core',
        source_file: null,
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('annotates failed migrations with live-schema classification in JSON output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dbHistoryCommand.handler([], { json: true });

    const output = logSpy.mock.calls.map((call) => call.join('')).join('\n');
    const parsed = JSON.parse(output);

    expect(compareMock).toHaveBeenCalledWith({
      contents: {
        tableName: 'contents',
      },
    });
    expect(parsed).toEqual([
      expect.objectContaining({
        name: 'add_column_contents_script_text',
        classification: 'unresolved',
        recommendation:
          'Run `smrt db:migrate` to reconcile the live schema, then confirm this failed generated schema repair no longer appears as unresolved.',
      }),
      expect.objectContaining({
        name: 'add_index_idx_contents_published_at',
        classification: 'superseded',
        recommendation:
          'No current live-schema drift maps to this failed generated schema repair. Keep the row for audit history, but it no longer blocks the current schema.',
      }),
      expect.objectContaining({
        name: 'type_upgrade_contents_status',
        classification: 'superseded',
        recommendation:
          'No current live-schema drift maps to this failed generated schema repair. Keep the row for audit history, but it no longer blocks the current schema.',
        resolution: 'superseded',
      }),
      expect.objectContaining({
        name: 'baseline_schema',
        classification: null,
        recommendation: null,
      }),
    ]);
  });
});
