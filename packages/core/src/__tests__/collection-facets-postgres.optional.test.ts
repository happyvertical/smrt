/**
 * PostgreSQL scalar facet coverage for issue #1904.
 *
 * This file runs only in the disposable `test:postgres` lane. The regular
 * in-memory facet suite covers SQLite and DuckDB; without
 * SMRT_TEST_POSTGRES_URL this adapter-specific evidence is intentionally
 * skipped rather than inferred from the other backends.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field, SmrtObject, smrt } from '../index.js';
import { ObjectRegistry } from '../registry.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'issue_1904_postgres_facets';

@smrt({ tableName: 'issue_1904_postgres_facets' })
class Issue1904PostgresFacet extends SmrtObject {
  @field({ type: 'text' })
  status = '';
}

class Issue1904PostgresFacetCollection extends SmrtCollection<Issue1904PostgresFacet> {
  static readonly _itemClass = Issue1904PostgresFacet;
}

describe.skipIf(!pgUrl)('PostgreSQL facets (#1904)', () => {
  let db: DatabaseInterface;
  let collection: Issue1904PostgresFacetCollection;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-1904-facets-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;

    await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    const registration = ObjectRegistry.getClassByConstructor(
      Issue1904PostgresFacet,
    );
    const className =
      registration?.qualifiedName ||
      registration?.name ||
      Issue1904PostgresFacet.name;
    const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
    if (!ddl) throw new Error(`Missing schema DDL for ${className}`);
    await db.query(ddl);
  }, 60_000);

  afterAll(async () => {
    try {
      await db?.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    } finally {
      await db?.close?.();
    }
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE TABLE "${TABLE}"`);
    collection = await Issue1904PostgresFacetCollection.create({ db });
  });

  it('groups scalar values and applies a per-field limit', async () => {
    await collection.create({ status: 'open' });
    await collection.create({ status: 'closed' });
    await collection.create({ status: 'open' });

    await expect(
      collection.facets({ fields: [{ field: 'status', limit: 1 }] }),
    ).resolves.toEqual([
      {
        field: 'status',
        values: [{ value: 'open', count: 2 }],
      },
    ]);
  });
});
