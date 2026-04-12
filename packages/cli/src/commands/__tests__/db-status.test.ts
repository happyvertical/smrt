import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  autoDiscoverAndLoadMock,
  getPackageConfigMock,
  getDatabaseMock,
  getAllSchemasAsDefinitionsMock,
  compareMock,
  initializeMock,
  getAppliedMigrationsMock,
  getEngineMock,
  SchemaComparerMock,
  MigrationTrackerMock,
} = vi.hoisted(() => {
  const compare = vi.fn();
  const initialize = vi.fn();
  const getAppliedMigrations = vi.fn();
  const getEngine = vi.fn();

  class MockSchemaComparer {
    compare = compare;
  }

  class MockMigrationTracker {
    initialize = initialize;
    getAppliedMigrations = getAppliedMigrations;
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
            type: 'type_mismatch',
            table: 'contents',
            name: 'published_at',
            mismatch: {
              expected: 'TIMESTAMP',
              actual: 'TEXT',
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
        type: 'type_mismatch',
        recommendation:
          'Manual intervention required: expected TIMESTAMP, found TEXT.',
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
  });
});
