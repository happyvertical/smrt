import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  autoDiscoverAndLoadMock,
  getPackageConfigMock,
  getDatabaseMock,
  getAllSchemasAsDefinitionsMock,
  compareMock,
  closeMock,
  initializeMock,
  getAppliedMigrationsMock,
  getHistoryMock,
  getEngineMock,
  SchemaComparerMock,
  MigrationTrackerMock,
} = vi.hoisted(() => {
  const compare = vi.fn();
  const close = vi.fn();
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
    closeMock: close,
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
    process.exitCode = undefined;

    getPackageConfigMock.mockReturnValue({
      database: {
        type: 'postgres',
        url: 'postgresql://test:test@localhost:5432/test_db',
      },
    });

    getDatabaseMock.mockResolvedValue({
      url: 'postgresql://test:test@localhost:5432/test_db',
      getTableSchema: vi.fn(),
      close: closeMock,
    });

    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [
        {
          path: '/fake/.smrt/manifest.json',
          source: 'project',
          objectCount: 3,
          objectNames: ['@fake/app:Content'],
        },
      ],
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
    expect(parsed.manifests.details).toEqual([
      {
        path: '/fake/.smrt/manifest.json',
        source: 'project',
        objectCount: 3,
        objectNames: ['@fake/app:Content'],
      },
    ]);
    expect(parsed.schemaContract.localManifest).toEqual({
      ok: true,
      count: 1,
      paths: ['/fake/.smrt/manifest.json'],
    });
    expect(parsed.schemaContract.ok).toBe(true);
    expect(parsed.database.url).toBe(
      'postgresql://test:***@localhost:5432/test_db',
    );
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
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it('fails JSON status when only package manifests were discovered', async () => {
    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [
        {
          path: '/fake/node_modules/@happyvertical/smrt-content/dist/manifest.json',
          source: 'package',
          packageName: '@happyvertical/smrt-content',
          packageVersion: '1.2.3',
          objectCount: 1,
          objectNames: ['@happyvertical/smrt-content:Mirror'],
        },
      ],
      totalObjects: 1,
    });
    compareMock.mockResolvedValue({
      added_tables: [],
      dropped_tables: [],
      has_changes: false,
      changes: [],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dbStatusCommand.handler([], { json: true });

    const parsed = JSON.parse(
      logSpy.mock.calls.map((call) => call.join('')).join('\n'),
    );
    expect(process.exitCode).toBe(1);
    expect(parsed.schemaContract.ok).toBe(false);
    expect(parsed.schemaContract.failures).toContainEqual(
      expect.objectContaining({ code: 'missing_local_manifest' }),
    );
  });

  it('classifies failed additive migrations as superseded history when live drift is gone', async () => {
    compareMock.mockResolvedValue({
      added_tables: [],
      dropped_tables: [],
      has_changes: false,
      changes: [],
    });
    getHistoryMock.mockResolvedValue([
      {
        id: 'failed-1',
        name: 'add_column_contents_script_text',
        version: '1.0.0',
        checksum: 'abc',
        applied_checksum: null,
        applied_at: new Date('2026-04-12T10:00:00Z'),
        execution_time_ms: 1,
        package_name: null,
        source_file: null,
        status: 'failed',
        error_message: 'must be owner of table contents',
        attempts: 1,
        is_reversible: false,
        rolled_back_at: null,
        applied_by: null,
        batch: 1,
      },
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dbStatusCommand.handler([], { json: true });

    const parsed = JSON.parse(
      logSpy.mock.calls.map((call) => call.join('')).join('\n'),
    );
    expect(parsed.migrations.failed).toEqual({
      total: 1,
      actionRequired: 0,
      superseded: 1,
      manualReview: 0,
      details: [
        {
          name: 'add_column_contents_script_text',
          resolution: 'superseded',
          kind: 'add_column',
          reason:
            'Current manifests no longer require this generated schema change, so the failed row is retained history rather than active drift.',
          errorMessage: 'must be owner of table contents',
        },
      ],
    });
  });

  it('keeps failed migrations actionable when the live diff still requires them', async () => {
    compareMock.mockResolvedValue({
      added_tables: [],
      dropped_tables: [],
      has_changes: true,
      changes: [
        {
          type: 'type_upgrade',
          table: '_smrt_agent_schedules',
          name: 'agent_config',
          sql: 'ALTER TABLE _smrt_agent_schedules ALTER COLUMN agent_config TYPE JSONB USING agent_config::jsonb',
        },
      ],
    });
    getHistoryMock.mockResolvedValue([
      {
        id: 'failed-2',
        name: 'type_upgrade__smrt_agent_schedules_agent_config',
        version: '1.0.0',
        checksum: 'def',
        applied_checksum: null,
        applied_at: new Date('2026-04-12T10:00:00Z'),
        execution_time_ms: 1,
        package_name: null,
        source_file: null,
        status: 'failed',
        error_message:
          'default for column "agent_config" cannot be cast automatically to type jsonb',
        attempts: 1,
        is_reversible: false,
        rolled_back_at: null,
        applied_by: null,
        batch: 1,
      },
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dbStatusCommand.handler([], { json: true });

    const parsed = JSON.parse(
      logSpy.mock.calls.map((call) => call.join('')).join('\n'),
    );
    expect(parsed.migrations.failed.actionRequired).toBe(1);
    expect(parsed.migrations.failed.details[0]).toMatchObject({
      name: 'type_upgrade__smrt_agent_schedules_agent_config',
      resolution: 'action_required',
      kind: 'type_upgrade',
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
        {
          type: 'type_upgrade',
          table: 'contents',
          name: 'status',
          sql: 'ALTER TABLE contents ALTER COLUMN status TYPE JSONB USING status::jsonb',
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
            'Run `smrt db:migrate` to reconcile the live schema, then confirm this failed generated schema repair no longer appears as unresolved.',
          errorMessage: 'column missing',
        },
        {
          name: 'type_upgrade_contents_status',
          classification: 'unresolved',
          recommendation:
            'Run `smrt db:migrate` to reconcile the live schema, then confirm this failed generated schema repair no longer appears as unresolved.',
          errorMessage: 'cannot cast',
        },
      ],
      superseded: [
        {
          name: 'add_index_idx_contents_published_at',
          classification: 'superseded',
          recommendation:
            'No current live-schema drift maps to this failed generated schema repair. Keep the row for audit history, but it no longer blocks the current schema.',
          errorMessage: 'index already exists',
        },
      ],
      other: [],
    });
  });
});
