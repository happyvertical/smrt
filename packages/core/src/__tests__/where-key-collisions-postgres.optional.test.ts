/**
 * PostgreSQL run of the where-key rule: a record with two keys for one column
 * and operator is refused before any SQL is built, so the adapter cannot
 * change the outcome. One parametrised case over list, count and get proves
 * that on a real PostgreSQL connection, with the controls beside it. The full
 * matrix of spellings and surfaces is in `where-key-collisions.test.ts`.
 *
 * Runs only in the dedicated disposable PostgreSQL shard
 * (`SMRT_TEST_POSTGRES_URL`).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';
import { WhereClauseError } from '../where-keys.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'where_key_collision_pg_tickets';

// The scanner reads this config statically, so the table name is a literal.
@smrt({ tableName: 'where_key_collision_pg_tickets' })
class CollisionPgTicket extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @field({ type: 'text' })
  ownerId = '';

  @field({ type: 'integer' })
  priority = 0;
}

class CollisionPgTicketCollection extends SmrtCollection<CollisionPgTicket> {
  static readonly _itemClass = CollisionPgTicket;
}

/** Spellings that all resolve to the column `owner_id` for equality. */
const SPELLINGS = [
  'ownerId',
  'owner_id',
  'OwnerId',
  'ownerId =',
  'owner_id =',
] as const;
const PAIRS: Array<[string, Record<string, unknown>]> = [];
for (const first of SPELLINGS) {
  for (const second of SPELLINGS) {
    if (first === second) continue;
    PAIRS.push([
      `'${first}' then '${second}'`,
      { [first]: 'a', [second]: 'b' },
    ]);
  }
}

describe.skipIf(!pgUrl)('where key collisions on PostgreSQL', () => {
  let db: DatabaseInterface;
  let tickets: CollisionPgTicketCollection;
  let ticketOfB: string;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'CollisionPgTicket',
      CollisionPgTicketCollection,
    );
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-where-key-collisions-${crypto.randomUUID()}`,
      max: 4,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await getTestDatabase({
      db,
      type: 'postgres',
      classes: ['CollisionPgTicket'],
    });
    tickets = await CollisionPgTicketCollection.create({ db });
    await tickets.create({ title: 'a low', ownerId: 'a', priority: 1 });
    await tickets.create({ title: 'a high', ownerId: 'a', priority: 5 });
    ticketOfB = String(
      (await tickets.create({ title: 'b low', ownerId: 'b', priority: 1 })).id,
    );
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    } finally {
      await db.close?.();
    }
  });

  it.each(PAIRS)('list, count and get refuse %s', async (_label, where) => {
    await expect(tickets.list({ where })).rejects.toThrow(WhereClauseError);
    await expect(tickets.count({ where })).rejects.toMatchObject({
      code: 'INVALID_WHERE_CLAUSE',
      status: 400,
    });
    await expect(tickets.get({ ...where, id: ticketOfB })).rejects.toThrow(
      WhereClauseError,
    );
  });

  it('refuses two keys that both become an in-list on one column', async () => {
    const where = { ownerId: ['a'], 'owner_id in': ['b'] };
    await expect(tickets.list({ where })).rejects.toThrow(WhereClauseError);
    await expect(tickets.count({ where })).rejects.toThrow(WhereClauseError);
  });

  it('serves a range and a single filter in every spelling', async () => {
    const range = { ownerId: 'a', 'priority >=': 1, 'priority <': 5 };
    expect((await tickets.list({ where: range })).map((t) => t.title)).toEqual([
      'a low',
    ]);
    expect(await tickets.count({ where: range })).toBe(1);
    for (const key of SPELLINGS) {
      const where = { [key]: 'b' };
      expect((await tickets.list({ where })).map((t) => t.title)).toEqual([
        'b low',
      ]);
      expect(await tickets.count({ where })).toBe(1);
      expect((await tickets.get({ ...where, id: ticketOfB }))?.title).toBe(
        'b low',
      );
    }
  });
});
