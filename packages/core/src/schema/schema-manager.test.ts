import { beforeEach, describe, expect, it, vi } from 'vitest';

// schema-manager.ts emits debug traces via @happyvertical/logger; mock it so the
// tests can assert on the logger (S14 console→logger migration). createLogger is
// a spy too, so we can verify the per-instance level follows the `debug` option
// (a fixed level: 'info' would filter debug output — see PR #1469 review).
const { mockLogger, createLoggerMock } = vi.hoisted(() => {
  const mockLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return { mockLogger, createLoggerMock: vi.fn(() => mockLogger) };
});
vi.mock('@happyvertical/logger', () => ({
  createLogger: createLoggerMock,
}));

import { SchemaManager } from './schema-manager';
import type { SchemaDefinition } from './types';

function createSchema(tableName: string): SchemaDefinition {
  return {
    tableName,
    columns: {
      id: { type: 'TEXT', primaryKey: true },
      title: { type: 'TEXT' },
    },
    indexes: [],
    triggers: [],
    foreignKeys: [],
    version: 'test',
    dependencies: [],
  };
}

describe('SchemaManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses parameterized postgres introspection queries', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ column_name: 'id' }])
      .mockResolvedValueOnce([]);

    const db = {
      query,
      tableExists: vi.fn().mockResolvedValue(true),
      url: 'postgres://localhost/test',
    } as any;

    const manager = new SchemaManager(db, { engine: 'postgres' });
    await manager.ensureTable(createSchema('users'));

    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
      'users',
    );
  });

  it('quotes sqlite identifiers in pragma and alter statements', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'id' }])
      .mockResolvedValueOnce([]);

    const db = {
      query,
      tableExists: vi.fn().mockResolvedValue(true),
      url: 'sqlite::memory:',
    } as any;

    const manager = new SchemaManager(db, { engine: 'sqlite' });
    await manager.ensureTable(createSchema('user"prefs'));

    expect(query).toHaveBeenNthCalledWith(
      1,
      'PRAGMA table_info("user""prefs")',
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      'ALTER TABLE "user""prefs" ADD COLUMN "title" TEXT',
    );
  });

  it('only logs added columns when debug logging is enabled', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'id' }])
      .mockResolvedValueOnce([]);

    const db = {
      query,
      tableExists: vi.fn().mockResolvedValue(true),
      url: 'sqlite::memory:',
    } as any;

    const quietManager = new SchemaManager(db, { engine: 'sqlite' });
    await quietManager.ensureTable(createSchema('users'));
    expect(mockLogger.debug).not.toHaveBeenCalled();
    // Without debug, the logger is created at 'info' so debug output is filtered.
    expect(createLoggerMock).toHaveBeenCalledWith({ level: 'info' });

    query.mockReset();
    query.mockResolvedValueOnce([{ name: 'id' }]).mockResolvedValueOnce([]);

    const verboseManager = new SchemaManager(db, {
      engine: 'sqlite',
      debug: true,
    });
    await verboseManager.ensureTable(createSchema('users'));

    expect(mockLogger.debug).toHaveBeenCalledWith(
      '[SchemaManager] Added 1 missing column(s) to "users"',
    );
    // The debug option must raise the logger level so the trace actually emits.
    expect(createLoggerMock).toHaveBeenCalledWith({ level: 'debug' });
  });
});
