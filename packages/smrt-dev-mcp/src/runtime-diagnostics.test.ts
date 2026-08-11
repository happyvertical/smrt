import { resolve } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runRuntimeDiagnostic,
  sanitizeRuntimeArguments,
  sanitizeRuntimeError,
} from './runtime-diagnostics.js';

describe('runtime diagnostics adapter', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      dbid: `smrt-dev-mcp-runtime-${crypto.randomUUID()}`,
    });
  });

  afterEach(async () => {
    const client = db.client as { close?: () => void | Promise<void> };
    await client.close?.();
  });

  it('returns a successful static-only result when no connection is configured', async () => {
    const connect = vi.fn();
    const result = await runRuntimeDiagnostic(
      'migration-status',
      {},
      {
        env: {},
        connect,
        configLoader: async () => ({}),
      },
    );

    expect(result).toMatchObject({
      status: 'not-configured',
      mode: 'static-only',
      provenance: {
        source: 'static-only',
        observation: 'none',
        connectionSource: null,
        scope: { mode: 'global' },
      },
      diagnostics: [{ code: 'runtime-not-configured' }],
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('uses per-call, environment, then packages.cli.database precedence', async () => {
    const connect = vi.fn(async () => db);
    const configLoader = vi.fn(async () => ({
      packages: {
        cli: { database: { type: 'sqlite', url: 'file:config.db' } },
      },
    }));

    await runRuntimeDiagnostic(
      'migration-status',
      { dbUrl: ':memory:', dbType: 'sqlite' },
      {
        env: { SMRT_DEV_DB_URL: 'file:env.db' },
        connect,
        configLoader,
      },
    );
    expect(connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'sqlite', url: ':memory:' }),
    );
    expect(configLoader).not.toHaveBeenCalled();

    connect.mockClear();
    await runRuntimeDiagnostic(
      'migration-status',
      {},
      {
        env: { SMRT_DEV_DB_URL: 'file:env.db' },
        connect,
        configLoader,
      },
    );
    expect(connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'sqlite',
        url: `file:${resolve(process.cwd(), 'env.db')}`,
      }),
    );
    expect(configLoader).not.toHaveBeenCalled();

    connect.mockClear();
    await runRuntimeDiagnostic(
      'migration-status',
      {},
      {
        env: {},
        connect,
        configLoader,
      },
    );
    expect(connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'sqlite',
        url: `file:${resolve(process.cwd(), 'config.db')}`,
      }),
    );
    expect(configLoader).toHaveBeenCalledWith(
      expect.objectContaining({ cache: false, searchParents: true }),
    );
  });

  it('resolves local database paths from rootDir and closes owned handles', async () => {
    const close = vi.fn();
    const fakeDb = {
      client: { close },
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as DatabaseInterface;
    const connect = vi.fn(async () => fakeDb);
    const rootDir = resolve(process.cwd(), 'fixtures', 'project');

    await runRuntimeDiagnostic(
      'migration-status',
      {
        rootDir,
        dbUrl: './runtime/dev.sqlite',
        dbType: 'sqlite',
      },
      {
        env: {},
        connect,
        ownsConnections: true,
        configLoader: async () => ({}),
      },
    );

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'sqlite',
        url: resolve(rootDir, 'runtime/dev.sqlite'),
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('reads a real seeded SQLite database through the lazy adapter', async () => {
    await db.query(`CREATE TABLE _smrt_schema_migrations (
      id TEXT PRIMARY KEY, name TEXT, version TEXT, package_name TEXT,
      status TEXT, applied_at TEXT, execution_time_ms INTEGER,
      attempts INTEGER, error_message TEXT
    )`);
    await db.query(
      `INSERT INTO _smrt_schema_migrations VALUES
       ('m1', 'seeded failure', '1', 'demo', 'failed', ?, 5, 1,
        'postgres://user:secret@db/app password=hunter2')`,
      '2026-08-11T18:00:00.000Z',
    );

    const result = await runRuntimeDiagnostic(
      'migration-status',
      { dbUrl: ':memory:', dbType: 'sqlite' },
      {
        env: {},
        connect: async () => db,
        configLoader: async () => ({}),
      },
    );

    expect(result).toMatchObject({
      status: 'available',
      provenance: {
        source: 'runtime',
        observation: 'live-db',
        engine: 'sqlite',
        connectionSource: 'argument',
        scope: { mode: 'global' },
      },
      data: { counts: { failed: 1 } },
    });
    expect(JSON.stringify(result)).not.toContain('user:secret');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('only allows a request tenant to narrow an identical trusted tenant scope', async () => {
    const connect = vi.fn(async () => db);
    const denied = await runRuntimeDiagnostic(
      'recent-changes',
      { dbUrl: ':memory:', dbType: 'sqlite', tenantId: 'tenant-b' },
      {
        env: { SMRT_DEV_TENANT_ID: 'tenant-a' },
        connect,
        configLoader: async () => ({}),
      },
    );
    expect(denied).toMatchObject({
      status: 'unavailable',
      diagnostics: [{ code: 'tenant-scope-denied' }],
    });
    expect(connect).not.toHaveBeenCalled();

    await runRuntimeDiagnostic(
      'recent-changes',
      { dbUrl: ':memory:', dbType: 'sqlite', tenantId: 'tenant-a' },
      {
        env: { SMRT_DEV_TENANT_ID: 'tenant-a' },
        connect,
        configLoader: async () => ({}),
      },
    );
    expect(connect).toHaveBeenCalledOnce();
  });

  it('labels declared and observed registry facts without exposing registry blobs', async () => {
    await db.query(`CREATE TABLE _smrt_registry (
      class_name TEXT PRIMARY KEY, schema_version TEXT, fields TEXT,
      relationships TEXT, config TEXT, manifest TEXT, last_updated TEXT
    )`);
    await db.query(
      `INSERT INTO _smrt_registry VALUES
       ('Article', '3', '{"password":"fields-secret"}', '{}',
        '{"token":"config-secret"}', '{"tableName":"articles"}', ?)`,
      '2026-08-11T18:00:00.000Z',
    );
    const result = await runRuntimeDiagnostic(
      'registry-drift',
      { dbUrl: ':memory:', dbType: 'sqlite', rootDir: process.cwd() },
      {
        env: {},
        connect: async () => db,
        configLoader: async () => ({}),
        introspect: async () =>
          JSON.stringify({
            manifestSource: 'manifest',
            manifestPath: '.smrt/manifest.json',
            objectCount: 2,
            objects: [
              { className: 'Article', tableName: 'articles' },
              { className: 'Draft', tableName: 'drafts' },
            ],
          }),
      },
    );

    expect(result).toMatchObject({
      status: 'available',
      data: {
        declared: {
          source: 'static',
          observation: 'declared-artifact',
        },
        observed: {
          source: 'runtime',
          observation: 'live-db',
        },
        drift: {
          declaredOnly: ['Draft'],
          registeredOnly: [],
          matched: ['Article'],
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /fields-secret|config-secret|"(?:fields|config|manifest)":/,
    );
  });

  it('sanitizes connection arguments and errors', async () => {
    expect(
      sanitizeRuntimeArguments({
        rootDir: '/project',
        dbUrl: 'postgres://user:password@db/app',
        token: 'sk-ABCDEFGHIJKLMNOP',
      }),
    ).toEqual({ rootDir: '/project' });
    expect(
      sanitizeRuntimeError(
        new Error(
          'failed postgres://user:password@db/app password=hunter2 sk-ABCDEFGHIJKLMNOP',
        ),
      ),
    ).not.toMatch(/user:password|hunter2|ABCDEFGHIJKLMNOP/);

    const failed = await runRuntimeDiagnostic(
      'migration-status',
      {
        dbUrl: 'postgres://user:password@db/app',
        dbType: 'postgres',
      },
      {
        env: {},
        connect: async () => {
          throw new Error('postgres://user:password@db/app password=hunter2');
        },
        configLoader: async () => ({}),
      },
    );
    expect(JSON.stringify(failed)).not.toMatch(/user:password|hunter2/);
    expect(failed).toMatchObject({
      status: 'unavailable',
      diagnostics: [{ code: 'connection-unavailable' }],
    });
  });
});
