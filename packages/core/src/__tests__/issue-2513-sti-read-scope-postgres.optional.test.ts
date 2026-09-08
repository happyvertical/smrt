/** PostgreSQL adapter coverage for the bounded STI discriminator scope. */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { SmrtObject, smrt } from '../index.js';
import { ObjectRegistry } from '../registry.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'issue_2513_postgres_sti_scope';
const CURRENT_TYPE = '@happyvertical/smrt-core:Issue2513PgCurrent';
const HISTORICAL_TYPE = '@happyvertical/smrt-core:Issue2513PgHistorical';

@smrt({
  tableName: 'issue_2513_postgres_sti_scope',
  tableStrategy: 'sti',
})
class Issue2513PgEvent extends SmrtObject {
  title: string = '';
}

@smrt()
class Issue2513PgCurrent extends Issue2513PgEvent {}

@smrt()
class Issue2513PgHistorical extends Issue2513PgEvent {}

class Issue2513PgCurrentCollection extends SmrtCollection<Issue2513PgCurrent> {
  static readonly _itemClass = Issue2513PgCurrent;
}

class Issue2513PgHistoricalCollection extends SmrtCollection<Issue2513PgHistorical> {
  static readonly _itemClass = Issue2513PgHistorical;
}

describe.skipIf(!pgUrl)('bounded STI read scope on PostgreSQL (#2513)', () => {
  let db: DatabaseInterface;
  let current: Issue2513PgCurrentCollection;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-2513-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    const registration = ObjectRegistry.getClassByConstructor(Issue2513PgEvent);
    const className =
      registration?.qualifiedName ??
      registration?.name ??
      Issue2513PgEvent.name;
    const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
    if (!ddl) throw new Error(`Missing schema DDL for ${className}`);
    await db.query(ddl);

    const historical = await Issue2513PgHistoricalCollection.create({ db });
    current = await Issue2513PgCurrentCollection.create({ db });
    await current.create({ title: 'current' });
    await historical.create({ title: 'historical' });
  }, 60_000);

  afterAll(async () => {
    try {
      await db?.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    } finally {
      await db?.close?.();
    }
  });

  it('binds a qualified allowlist and hydrates both registered sibling types', async () => {
    const rows = await current.list({
      stiScope: { types: [CURRENT_TYPE, HISTORICAL_TYPE] },
      orderBy: 'title ASC',
      limit: 2,
    });
    expect(rows.map((row) => row.title)).toEqual(['current', 'historical']);
    expect(rows[0]).toBeInstanceOf(Issue2513PgCurrent);
    expect(rows[1]).toBeInstanceOf(Issue2513PgHistorical);
  });
});
