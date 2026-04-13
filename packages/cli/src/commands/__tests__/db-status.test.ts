import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  autoDiscoverAndLoadMock,
  getPackageConfigMock,
  getDatabaseMock,
  getAllSchemasAsDefinitionsMock,
  compareMock,
  initializeMock,
  getAppliedMigrationsMock,
  getHistoryMock,
  getEngineMock,
  SchemaComparerMock,
  MigrationTrackerMock,
} = vi.hoisted(() => {
  const compare = vi.fn();
  const initialize = vi.fn();
  const getAppliedMigrations = vi.fn();
  const getHistory = vi.fn();
  const getEngine = vi.fn();

  class MockSchemaComparer {
    compare = compare;
  }

  class MockMigrationTracker {
    initialize = initialize;
    getAppliedMigrations = getAppliedMigrations;
    getHistory = getHistory;
    getEngine = getEngine;
  }

  return {
    autoDiscoverAndLoadMock: vi.fn(),
    getPackageConfigMock: vi.fn(),
    getDatabaseMock: vi.fn(),
    getAllSchemasAsDefinitionsMock: vi.fn(),
    compareMock: compare,
    initializeMock: initialize,
    getAppliedMigrationsMock: getAppliedMigrations,
    getHistoryMock: getHistory,
    getEngineMock: getEngine,
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

import { dbStatusCommand, summarizeSchemaDiff } from '../db-status.js';

describe('db:status', () => {
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
    getAppliedMigrationsMock.mockResolvedValue([]);
    getHistoryMock.mockResolvedValue([]);
    getEngineMock.mockReturnValue('postgres');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('summarizes live schema drift into actionable status entries', () => {
    expect(
      summarizeSchemaDiff({
        added_tables: [{ tableName: 'contents' }],
        changes: [
          {
            type: 'add_column',
            table: 'contents',
            name: 'script_text',
          },
          {
            type: 'type_upgrade',
            table: 'contents',
            name: 'published_at',
            sql: '-- SQLite: Type upgrade for "published_at" requires table recreation',
          },
          {
            type: 'type_mismatch',
            table: 'contents',
            name: 'video_asset_id',
            mismatch: {
              expected: 'TEXT',
              actual: 'INTEGER',
            },
          },
        ],
      }),
    ).toEqual([
      {
        name: 'contents',
        type: 'missing_table',
        recommendation:
          'Run `smrt db:migrate` to create the missing table in the live database.',
      },
      {
        name: 'contents.script_text',
        type: 'missing_column',
        recommendation:
          'Run `smrt db:migrate` to add the missing column before application writes hit this table.',
      },
      {
        name: 'contents.published_at',
        type: 'type_upgrade',
        recommendation:
          'Manual intervention required: this live column needs a type upgrade that the current database engine cannot auto-apply.',
      },
      {
        name: 'contents.video_asset_id',
        type: 'type_mismatch',
        recommendation:
          'Manual intervention required: expected TEXT, found INTEGER.',
      },
    ]);
  });

  it('reports live drift in JSON output instead of only migration history', async () => {
    compareMock.mockResolvedValue({
      added_tables: [],
      dropped_tables: [],
      has_changes: true,
      changes: [
        {
          type: 'add_column',
          table: 'contents',
          name: 'script_text',
        },
        {
          type: 'add_index',
          table: 'contents',
          name: 'idx_contents_published_at',
        },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dbStatusCommand.handler([], { json: true });

    expect(compareMock).toHaveBeenCalledWith({
      contents: {
        tableName: 'contents',
      },
    });

    const output = logSpy.mock.calls.map((call) => call.join('')).join('\n');
    const parsed = JSON.parse(output);

    expect(parsed.manifests.objects).toBe(3);
    expect(parsed.drift).toEqual([
      {
        name: 'contents.script_text',
        type: 'missing_column',
        recommendation:
          'Run `smrt db:migrate` to add the missing column before application writes hit this table.',
      },
      {
        name: 'contents.idx_contents_published_at',
        type: 'missing_index',
        recommendation:
          'Run `smrt db:migrate` to add the missing index and reconcile the live schema.',
      },
    ]);
    expect(parsed.failedMigrations).toEqual({
      unresolved: [],
      superseded: [],
      other: [],
    });
  });

  it('omits no-op type upgrades from drift output', () => {
    expect(
      summarizeSchemaDiff({
        added_tables: [],
        changes: [
          {
            type: 'type_upgrade',
            table: 'contents',
            name: 'metadata',
            sql: '-- SQLite: "metadata" already stores JSON as TEXT (no change needed)',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('classifies failed additive migrations against current live drift', async () => {
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
        name: 'add_column_contents_script_text',
        error_message: 'column missing',
      },
      {
        name: 'add_index_idx_contents_published_at',
        error_message: 'index already exists',
      },
      {
        name: 'type_upgrade_contents_status',
        error_message: 'cannot cast',
      },
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dbStatusCommand.handler([], { json: true });

    const output = logSpy.mock.calls.map((call) => call.join('')).join('\n');
    const parsed = JSON.parse(output);

    expect(parsed.failedMigrations).toEqual({
      unresolved: [
        {
          name: 'add_column_contents_script_text',
          classification: 'unresolved',
          recommendation:
            'Run `smrt db:migrate` to reconcile the live schema, then confirm this failed additive migration no longer appears as unresolved.',
          errorMessage: 'column missing',
        },
      ],
      superseded: [
        {
          name: 'add_index_idx_contents_published_at',
          classification: 'superseded',
          recommendation:
            'No current live-schema drift maps to this failed additive migration. Keep the row for audit history, but it no longer blocks the current schema.',
          errorMessage: 'index already exists',
        },
      ],
      other: [
        {
          name: 'type_upgrade_contents_status',
          classification: 'other',
          recommendation:
            'Inspect this failed migration directly. It is not a superseded additive repair and may still need manual attention.',
          errorMessage: 'cannot cast',
        },
      ],
    });
  });
});
