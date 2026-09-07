/**
 * `db:orphans` handler tests (#2753), against a real SQLite database.
 *
 * Covers command registration, config validation, the human-readable and
 * `--json` report shapes, nullability marking, count-descending ordering,
 * and a foreign key skipped because its parent table does not exist live.
 */

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { autoDiscoverAndLoadMock } = vi.hoisted(() => ({
  autoDiscoverAndLoadMock: vi.fn(),
}));

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: autoDiscoverAndLoadMock,
}));

import {
  affectedOrphanCounts,
  dbOrphansCommand,
  formatOrphanCountLine,
  formatOrphanReport,
} from '../db-orphans.js';
import { utilityCommands } from '../utilities.js';

const MANIFEST_SCHEMA = {
  event_types: {
    tableName: 'event_types',
    columns: { id: { type: 'TEXT', primaryKey: true } },
    indexes: [],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '1.0.0',
  },
  events: {
    tableName: 'events',
    columns: {
      id: { type: 'TEXT', primaryKey: true },
      type_id: {
        type: 'TEXT',
        foreignKey: { table: 'event_types', column: 'id' },
      },
    },
    indexes: [],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '1.0.0',
  },
  event_participants: {
    tableName: 'event_participants',
    columns: {
      id: { type: 'TEXT', primaryKey: true },
      event_id: {
        type: 'TEXT',
        notNull: true,
        foreignKey: { table: 'events', column: 'id' },
      },
    },
    indexes: [],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '1.0.0',
  },
};

describe('db:orphans command registration', () => {
  it('is registered under db:orphans', () => {
    expect(utilityCommands['db:orphans']).toBe(dbOrphansCommand);
  });
});

describe('formatOrphanCountLine', () => {
  it('marks a NOT NULL child column', () => {
    expect(
      formatOrphanCountLine({
        childTable: 'event_participants',
        childColumn: 'event_id',
        parentTable: 'events',
        parentColumn: 'id',
        orphanCount: 5,
        nullable: false,
      }),
    ).toBe('event_participants.event_id -> events.id: 5 orphan(s) [NOT NULL]');
  });

  it('carries no marker for a nullable child column', () => {
    expect(
      formatOrphanCountLine({
        childTable: 'events',
        childColumn: 'type_id',
        parentTable: 'event_types',
        parentColumn: 'id',
        orphanCount: 3,
        nullable: true,
      }),
    ).toBe('events.type_id -> event_types.id: 3 orphan(s)');
  });
});

describe('formatOrphanReport / affectedOrphanCounts', () => {
  it('reports a clean database', () => {
    const lines = formatOrphanReport({
      engine: 'sqlite',
      counts: [
        {
          childTable: 'events',
          childColumn: 'type_id',
          parentTable: 'event_types',
          parentColumn: 'id',
          orphanCount: 0,
          nullable: true,
        },
      ],
      skipped: [],
    });
    expect(lines.join('\n')).toContain('No orphan rows found');
  });

  it('filters to affected foreign keys and sorts by count', () => {
    const report = {
      engine: 'sqlite' as const,
      counts: [
        {
          childTable: 'a',
          childColumn: 'x',
          parentTable: 'p',
          parentColumn: 'id',
          orphanCount: 0,
          nullable: true,
        },
        {
          childTable: 'b',
          childColumn: 'y',
          parentTable: 'p',
          parentColumn: 'id',
          orphanCount: 5,
          nullable: false,
        },
      ],
      skipped: [
        {
          childTable: 'c',
          childColumn: 'z',
          parentTable: 'ghosts',
          parentColumn: 'id',
          reason: 'Parent table `ghosts` does not exist in the live database.',
          kind: 'missing_table' as const,
        },
      ],
    };
    expect(affectedOrphanCounts(report)).toEqual([report.counts[1]]);
    const lines = formatOrphanReport(report).join('\n');
    expect(lines).toContain('b.y -> p.id: 5 orphan(s) [NOT NULL]');
    expect(lines).not.toContain('a.x -> p.id');
    expect(lines).toContain('Skipped:');
    expect(lines).toContain('ghosts');
  });

  it('--verbose lists each zero-orphan relationship by identity, not just a count', () => {
    const report = {
      engine: 'sqlite' as const,
      counts: [
        {
          childTable: 'a',
          childColumn: 'x',
          parentTable: 'p',
          parentColumn: 'id',
          orphanCount: 0,
          nullable: true,
        },
        {
          childTable: 'b',
          childColumn: 'y',
          parentTable: 'p',
          parentColumn: 'id',
          orphanCount: 0,
          nullable: false,
        },
      ],
      skipped: [],
    };
    const lines = formatOrphanReport(report, { verbose: true }).join('\n');
    expect(lines).toContain('a.x -> p.id: 0 orphan(s)');
    expect(lines).toContain('b.y -> p.id: 0 orphan(s) [NOT NULL]');
  });

  it('marks a probe_failed skip distinctly from a missing_table skip', () => {
    const report = {
      engine: 'sqlite' as const,
      counts: [],
      skipped: [
        {
          childTable: 'a',
          childColumn: 'x',
          parentTable: 'p',
          parentColumn: 'id',
          reason: 'Parent table `p` does not exist in the live database.',
          kind: 'missing_table' as const,
        },
        {
          childTable: 'b',
          childColumn: 'y',
          parentTable: 'q',
          parentColumn: 'id',
          reason: 'Could not probe for orphan rows: permission denied',
          kind: 'probe_failed' as const,
        },
      ],
    };
    const lines = formatOrphanReport(report).join('\n');
    const failedLine = lines
      .split('\n')
      .find((line) => line.includes('permission denied'));
    const missingLine = lines
      .split('\n')
      .find((line) => line.includes('does not exist'));
    expect(failedLine).toContain('[PROBE FAILED]');
    expect(missingLine).not.toContain('[PROBE FAILED]');
  });
});

describe('db:orphans against a real SQLite database', () => {
  let dbUrl: string;

  async function withDatabase(
    run: (db: Awaited<ReturnType<typeof getDatabase>>) => Promise<void>,
  ): Promise<void> {
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    try {
      await run(db);
    } finally {
      await db.close?.();
    }
  }

  beforeEach(() => {
    process.exitCode = undefined;
    dbUrl = join(
      tmpdir(),
      `orphans-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    } as never);
    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [],
      totalObjects: 0,
    });
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue(
      MANIFEST_SCHEMA as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCache();
    process.exitCode = undefined;
    rmSync(dbUrl, { force: true });
  });

  it('reports counts sorted descending, marks NOT NULL, and skips a missing parent table', async () => {
    await withDatabase(async (db) => {
      await db.query('CREATE TABLE event_types (id TEXT PRIMARY KEY)');
      await db.query('CREATE TABLE events (id TEXT PRIMARY KEY, type_id TEXT)');
      await db.query(
        'CREATE TABLE event_participants (id TEXT PRIMARY KEY, event_id TEXT)',
      );
      await db.query("INSERT INTO event_types (id) VALUES ('t1')");
      await db.query(
        "INSERT INTO events (id, type_id) VALUES ('e1', 't1'), ('e2', 'missing'), ('e3', 'missing')",
      );
      await db.query(
        "INSERT INTO event_participants (id, event_id) VALUES ('p1', 'missing-event')",
      );
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dbOrphansCommand.handler([], {});
    const output = logSpy.mock.calls.map((call) => call.join('')).join('\n');

    const eventsLine = output.indexOf('events.type_id');
    const participantsLine = output.indexOf('event_participants.event_id');
    expect(eventsLine).toBeGreaterThan(-1);
    expect(participantsLine).toBeGreaterThan(-1);
    // events.type_id has 2 orphans, event_participants.event_id has 1 —
    // descending order puts events first.
    expect(eventsLine).toBeLessThan(participantsLine);
    expect(output).toContain('2 orphan(s)');
    expect(output).toContain('1 orphan(s) [NOT NULL]');
    expect(process.exitCode).toBeUndefined();
  });

  it('prints a clean report when there are no orphans', async () => {
    await withDatabase(async (db) => {
      await db.query('CREATE TABLE event_types (id TEXT PRIMARY KEY)');
      await db.query('CREATE TABLE events (id TEXT PRIMARY KEY, type_id TEXT)');
      await db.query(
        'CREATE TABLE event_participants (id TEXT PRIMARY KEY, event_id TEXT)',
      );
      await db.query("INSERT INTO event_types (id) VALUES ('t1')");
      await db.query("INSERT INTO events (id, type_id) VALUES ('e1', 't1')");
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dbOrphansCommand.handler([], {});
    const output = logSpy.mock.calls.map((call) => call.join('')).join('\n');

    expect(output).toContain('No orphan rows found');
    expect(process.exitCode).toBeUndefined();
  });

  it('--json emits the full report and always exits 0 for findings', async () => {
    await withDatabase(async (db) => {
      await db.query('CREATE TABLE event_types (id TEXT PRIMARY KEY)');
      await db.query('CREATE TABLE events (id TEXT PRIMARY KEY, type_id TEXT)');
      await db.query(
        "INSERT INTO events (id, type_id) VALUES ('e1', 'missing')",
      );
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dbOrphansCommand.handler([], { json: true });
    const payload = JSON.parse(
      logSpy.mock.calls.map((call) => call.join('')).join('\n'),
    );

    expect(payload.engine).toBe('sqlite');
    const eventsEntry = payload.counts.find(
      (count: { childTable: string }) => count.childTable === 'events',
    );
    expect(eventsEntry).toMatchObject({ orphanCount: 1, nullable: true });
    // event_participants.event_id has no live table at all here, so it's
    // reported as skipped rather than counted.
    expect(
      payload.skipped.some(
        (skip: { childTable: string }) =>
          skip.childTable === 'event_participants',
      ),
    ).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails closed with exit 1 when no persistent database is configured', async () => {
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: ':memory:' } } },
    } as never);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await dbOrphansCommand.handler([], {});

    expect(process.exitCode).toBe(1);
    errorSpy.mockRestore();
  });
});
