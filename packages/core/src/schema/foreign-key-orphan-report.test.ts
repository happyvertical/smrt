/**
 * Per-foreign-key orphan count report (#2753) against a real SQLite database.
 *
 * Drives a manifest with a nullable and a NOT NULL foreign key, seeds live
 * orphan rows for each, and asserts the report counts them correctly, marks
 * nullability, sorts by count descending, and skips a relationship whose
 * parent table does not exist live rather than failing the whole report.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { collectForeignKeyOrphanCounts } from './foreign-key-orphan-report.js';
import type { SchemaDefinition } from './types.js';

let db: DatabaseProvider | undefined;

async function openDatabase(): Promise<DatabaseProvider> {
  db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  return db;
}

afterEach(async () => {
  if (db && typeof db.close === 'function') {
    try {
      await db.close();
    } catch {
      // in-memory databases occasionally reject a double close
    }
  }
  db = undefined;
});

/**
 * Manifest for three tables:
 * - `event_types` / `events`: nullable `events.type_id -> event_types.id`.
 * - `events` / `event_participants`: NOT NULL
 *   `event_participants.event_id -> events.id`.
 * - `event_participants.ghost_id -> ghosts.id`: `ghosts` never gets created
 *   live, so the probe must skip it rather than fail.
 */
function manifest(): Record<string, SchemaDefinition> {
  return {
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
        ghost_id: {
          type: 'TEXT',
          foreignKey: { table: 'ghosts', column: 'id' },
        },
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    },
  };
}

async function seedTables(database: DatabaseProvider): Promise<void> {
  await database.query(`CREATE TABLE event_types (id TEXT PRIMARY KEY)`);
  await database.query(
    `CREATE TABLE events (id TEXT PRIMARY KEY, type_id TEXT)`,
  );
  await database.query(
    `CREATE TABLE event_participants (id TEXT PRIMARY KEY, event_id TEXT, ghost_id TEXT)`,
  );

  await database.query(`INSERT INTO event_types (id) VALUES ('t1')`);
  await database.query(
    `INSERT INTO events (id, type_id) VALUES ('e1', 't1'), ('e2', 't1'), ('e3', 'missing-type'), ('e4', NULL)`,
  );
  await database.query(
    `INSERT INTO event_participants (id, event_id, ghost_id) VALUES ` +
      `('p1', 'e1', NULL), ('p2', 'missing-event', NULL), ('p3', 'e2', NULL)`,
  );
}

describe('collectForeignKeyOrphanCounts', () => {
  it('counts orphans per foreign key, marks nullability, sorts by count descending, and skips a missing parent table', async () => {
    const database = await openDatabase();
    await seedTables(database);

    const report = await collectForeignKeyOrphanCounts(database, manifest());

    expect(report.engine).toBe('sqlite');
    expect(report.counts).toHaveLength(2);

    // Sorted descending: events.type_id has 1 orphan ('e3'), NULL ('e4') is
    // excluded by the probe's own `IS NOT NULL` guard.
    const [first, second] = report.counts;
    expect(first).toMatchObject({
      childTable: 'events',
      childColumn: 'type_id',
      parentTable: 'event_types',
      parentColumn: 'id',
      orphanCount: 1,
      nullable: true,
    });
    expect(second).toMatchObject({
      childTable: 'event_participants',
      childColumn: 'event_id',
      parentTable: 'events',
      parentColumn: 'id',
      orphanCount: 1,
      nullable: false,
    });

    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({
      childTable: 'event_participants',
      childColumn: 'ghost_id',
      parentTable: 'ghosts',
      parentColumn: 'id',
    });
    expect(report.skipped[0].reason).toContain('ghosts');
  });

  it('reports zero orphans and skips a relationship whose child table does not exist live', async () => {
    const database = await openDatabase();
    // Only create the parent tables; leave every child table missing.
    await database.query(`CREATE TABLE event_types (id TEXT PRIMARY KEY)`);

    const report = await collectForeignKeyOrphanCounts(database, {
      event_types: manifest().event_types,
      events: manifest().events,
    });

    expect(report.counts).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].childTable).toBe('events');
    expect(report.skipped[0].reason).toContain('events');
  });

  it('reports a clean relationship with zero orphans', async () => {
    const database = await openDatabase();
    await database.query(`CREATE TABLE event_types (id TEXT PRIMARY KEY)`);
    await database.query(
      `CREATE TABLE events (id TEXT PRIMARY KEY, type_id TEXT)`,
    );
    await database.query(`INSERT INTO event_types (id) VALUES ('t1')`);
    await database.query(
      `INSERT INTO events (id, type_id) VALUES ('e1', 't1')`,
    );

    const report = await collectForeignKeyOrphanCounts(database, {
      event_types: manifest().event_types,
      events: manifest().events,
    });

    expect(report.counts).toHaveLength(1);
    expect(report.counts[0]).toMatchObject({ orphanCount: 0, nullable: true });
  });
});
