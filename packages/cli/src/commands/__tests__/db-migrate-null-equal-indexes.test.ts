import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  preflight: vi.fn(),
  migrate: vi.fn(),
  close: vi.fn(),
  discover: vi.fn(),
}));
vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: { getAllSchemasAsDefinitions: () => ({ example: {} }) },
}));
vi.mock('@happyvertical/smrt-core/migrations', () => ({
  collectNullEqualIndexTargets: () => [],
  preflightNullEqualIndexes: mocks.preflight,
  migrateNullEqualIndexes: mocks.migrate,
  nullEqualIndexStatements: () => [
    'DROP INDEX example',
    'CREATE UNIQUE INDEX example',
  ],
}));
vi.mock('@happyvertical/smrt-config', () => ({
  getPackageConfig: () => ({
    database: { type: 'postgres', url: 'postgres://localhost/test' },
  }),
}));
vi.mock('@happyvertical/sql', () => ({ getDatabase: async () => ({}) }));
vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: mocks.discover,
}));
vi.mock('../db-command-utils.js', () => ({
  closeDatabaseConnection: mocks.close,
  formatDatabaseDisplayUrl: () => 'test database',
}));

import { dbMigrateNullEqualIndexesCommand } from '../db-migrate-null-equal-indexes.js';

describe('db:migrate-null-equal-indexes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.exitCode = 0;
  });
  it('dry-run reports the plan without applying it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.preflight.mockResolvedValue({
      supported: true,
      summary: '1 pending',
      indexes: [{ table: 't', index: 'i', state: 'pending' }],
    });
    await dbMigrateNullEqualIndexesCommand.handler([], { 'dry-run': true });
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('DROP INDEX example;');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it('returns failure for a blocked preflight without applying any DDL', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.preflight.mockResolvedValue({
      supported: true,
      summary: '1 blocked',
      indexes: [
        {
          table: 't',
          index: 'i',
          state: 'blocked',
          reason: 'duplicate identity',
          detectorSql: 'SELECT duplicates',
        },
      ],
    });
    await dbMigrateNullEqualIndexesCommand.handler([], {});
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it('applies the explicit migration and tells operators to refresh every process', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.preflight.mockResolvedValue({
      supported: true,
      summary: '1 pending',
      indexes: [],
    });
    mocks.migrate.mockResolvedValue({ statements: ['DROP', 'CREATE'] });
    await dbMigrateNullEqualIndexesCommand.handler([], {});
    expect(mocks.migrate).toHaveBeenCalledTimes(1);
    expect(
      log.mock.calls.some(([message]) =>
        String(message).includes('EVERY application process'),
      ),
    ).toBe(true);
  });
});
