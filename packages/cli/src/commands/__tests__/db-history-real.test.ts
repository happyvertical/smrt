import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { MigrationTracker } from '@happyvertical/smrt-core/migrations';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { autoDiscoverAndLoadMock } = vi.hoisted(() => ({
  autoDiscoverAndLoadMock: vi.fn(),
}));

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: autoDiscoverAndLoadMock,
}));

import { dbHistoryCommand } from '../db-history.js';

/**
 * db:history against a REAL SQLite database, focusing on the human-readable
 * rendering and query-filter paths the existing mock-based suite does not
 * exercise. Real migration rows are written via the real MigrationTracker, then
 * the command re-opens the same file and renders them.
 *
 * Discovery is mocked so the failed-migration live-schema comparison short-
 * circuits (db.getTableSchema is undefined on the SQLite adapter for these
 * tests is handled by the command's typeof guard); the rendering and summary
 * logic still runs for real.
 */
describe('db:history (real SQLite rendering)', () => {
  let dbUrl: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  async function seed(): Promise<void> {
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    const tracker = new MigrationTracker({ db });
    await tracker.initialize();
    await tracker.apply({
      id: 'create_alpha',
      description: 'alpha',
      version: '1.0.0',
      up: ['CREATE TABLE alpha (id TEXT PRIMARY KEY)'],
      down: ['DROP TABLE alpha'],
    });
    await tracker.apply({
      id: 'create_beta',
      description: 'beta',
      version: '1.1.0',
      up: ['CREATE TABLE beta (id TEXT PRIMARY KEY)'],
      down: [],
    });
    await db.close?.();
  }

  beforeEach(() => {
    process.exitCode = undefined;
    dbUrl = join(
      tmpdir(),
      `cov-history-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    } as any);
    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [{ path: '/fake/.smrt/manifest.json' }],
      totalObjects: 1,
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCache();
    try {
      rmSync(dbUrl, { force: true });
    } catch {
      // ignore
    }
  });

  function output(): string {
    return logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  }

  function errorOutput(): string {
    return errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  }

  it('errors out when the database is configured as :memory:', async () => {
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: ':memory:' } } },
    } as any);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as any);

    await dbHistoryCommand.handler([], {});

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorOutput()).toContain('Database configuration required');
    exitSpy.mockRestore();
  });

  it('emits a JSON error when the database is not configured', async () => {
    clearCache();
    setConfig({ packages: { cli: { database: { url: '' } } } } as any);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as any);

    await dbHistoryCommand.handler([], { json: true });

    expect(output()).toContain('Database not configured');
    exitSpy.mockRestore();
  });

  it('renders the applied migrations in compact human-readable form', async () => {
    await seed();

    await dbHistoryCommand.handler([], {});

    const out = output();
    expect(out).toContain('Migration History');
    expect(out).toContain('create_alpha');
    expect(out).toContain('create_beta');
    expect(out).toContain('Summary:');
    expect(out).toContain('2 completed');
  });

  it('renders verbose details including version and checksum', async () => {
    await seed();

    await dbHistoryCommand.handler([], { verbose: true });

    const out = output();
    expect(out).toContain('Version: 1.0.0');
    expect(out).toContain('Checksum:');
  });

  it('serializes the full history as JSON', async () => {
    await seed();

    await dbHistoryCommand.handler([], { json: true });

    const parsed = JSON.parse(output());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((m: any) => m.name)).toContain('create_alpha');
    expect(parsed[0].status).toBe('completed');
  });

  it('reports no matching migrations when none have been applied', async () => {
    // Initialize the tracker tables but apply nothing.
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    const tracker = new MigrationTracker({ db });
    await tracker.initialize();
    await db.close?.();

    await dbHistoryCommand.handler([], {});

    expect(output()).toContain('No migrations found matching criteria');
  });

  it('filters by status, hiding non-matching rows', async () => {
    await seed();

    await dbHistoryCommand.handler([], { status: 'failed' });

    // No failed migrations were seeded, so the filtered result is empty.
    expect(output()).toContain('No migrations found matching criteria');
  });

  it('applies a --since lower bound on applied_at', async () => {
    await seed();

    // A future cutoff filters out every applied migration.
    await dbHistoryCommand.handler([], { since: '2999-01-01' });

    expect(output()).toContain('No migrations found matching criteria');
  });

  it('honors a numeric --limit', async () => {
    await seed();

    await dbHistoryCommand.handler([], { limit: 1 });

    expect(output()).toContain('Showing 1 migration');
  });
});
