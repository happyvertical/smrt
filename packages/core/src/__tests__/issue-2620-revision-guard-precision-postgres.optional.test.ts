/**
 * PostgreSQL revision compare-and-swap precision contract for issue #2620.
 *
 * The exact `toISOString()` equality predicate the guard used was unsatisfiable
 * for any row last written by raw SQL — `updated_at` is a microsecond column and
 * a JavaScript `Date` is not — and, on legacy `timestamp WITHOUT time zone`
 * schemas, for every row on a non-UTC host, because `pg` hydrates that type in
 * the process zone. Both turned the lost-race guard into a permanent
 * `RUNTIME_REVISION_CONFLICT`.
 *
 * The whole battery runs against both column shapes SMRT deployments hold:
 * the `TIMESTAMPTZ` this version materializes, and the `TIMESTAMP` that
 * pre-existing databases were created with.
 *
 * Runs only in the dedicated disposable PostgreSQL shard.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { postgresRevisionCandidates } from '../revision-guard.js';
import { getDDLStrategy } from '../schema/ddl/index.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'issue_2620_revision_guard_rows';
const NON_UTC_ZONE = 'America/Vancouver';

@smrt({ tableName: 'issue_2620_revision_guard_rows' })
class Issue2620RevisionGuardRow extends SmrtObject {
  @field()
  title: string = '';
}

class Issue2620RevisionGuardRows extends SmrtCollection<Issue2620RevisionGuardRow> {
  static readonly _itemClass = Issue2620RevisionGuardRow;
}

const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('PostgreSQL revision guard precision (#2620)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;
  let rows: Issue2620RevisionGuardRows;
  const originalTz = process.env.TZ;

  beforeAll(async () => {
    db = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-revision-guard-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0]);

    await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    const registration = ObjectRegistry.getClassByConstructor(
      Issue2620RevisionGuardRow,
    );
    const className =
      registration?.qualifiedName ||
      registration?.name ||
      Issue2620RevisionGuardRow.name;
    const schema = ObjectRegistry.getSchema(className);
    const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
    if (!schema || !ddl) throw new Error(`Missing schema for ${className}`);
    await db.query(ddl);
    for (const indexSql of getDDLStrategy('postgres').generateIndexes(schema)) {
      await db.query(indexSql);
    }
    ObjectRegistry.registerCollection(
      'Issue2620RevisionGuardRow',
      Issue2620RevisionGuardRows,
    );
    rows = (await Issue2620RevisionGuardRows.create({
      db,
    })) as Issue2620RevisionGuardRows;
  });

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  afterAll(async () => {
    try {
      await db?.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    } finally {
      await db?.close?.();
    }
  });

  /**
   * The stored `updated_at`'s microsecond field. Read on its own because it is
   * the one part of the value that renders identically for both column types
   * whatever the session TimeZone is.
   */
  async function storedMicroseconds(id: string): Promise<string> {
    const result = await db.query(
      `SELECT to_char(updated_at, 'US') AS microseconds FROM "${TABLE}" WHERE id = $1`,
      [id],
    );
    return (result.rows as Array<{ microseconds: string }>)[0].microseconds;
  }

  /**
   * Create a row and re-stamp it the way raw application SQL and SMRT's own
   * migration backfills do, leaving a microsecond `updated_at` that a
   * JavaScript `Date` cannot represent. The sub-millisecond tail is pinned so
   * the case cannot pass by landing on a millisecond boundary.
   */
  async function createRowWithMicrosecondRevision(): Promise<string> {
    const created = await rows.create({ title: 'original' });
    const id = String(created.id);
    await db.query(
      `UPDATE "${TABLE}" SET updated_at = date_trunc('milliseconds', CURRENT_TIMESTAMP) + interval '753 microseconds' WHERE id = $1`,
      [id],
    );
    expect(await storedMicroseconds(id)).toMatch(/753$/);
    return id;
  }

  async function loadRow(id: string): Promise<Issue2620RevisionGuardRow> {
    const loaded = await rows.get(id);
    if (!loaded) throw new Error('expected persisted row');
    return loaded;
  }

  describe.each([
    ['TIMESTAMPTZ', 'timestamptz'],
    [
      'TIMESTAMP',
      "timestamp without time zone USING updated_at AT TIME ZONE 'UTC'",
    ],
  ])('on a %s updated_at column', (_label, columnType) => {
    beforeAll(async () => {
      await db.query(
        `ALTER TABLE "${TABLE}" ALTER COLUMN updated_at TYPE ${columnType}`,
      );
      await db.query(`TRUNCATE TABLE "${TABLE}"`);
    });

    it('saves a row whose updated_at was written by raw SQL', async () => {
      const id = await createRowWithMicrosecondRevision();
      const loaded = await loadRow(id);
      const loadedRevision = loaded.updated_at as Date;

      loaded.title = 'renamed';
      await expect(loaded.save()).resolves.toBeDefined();

      const reloaded = await loadRow(id);
      expect(reloaded.title).toBe('renamed');
      expect((reloaded.updated_at as Date).getTime()).toBeGreaterThan(
        loadedRevision.getTime(),
      );
    });

    it('saves a row re-stamped by a bare CURRENT_TIMESTAMP statement', async () => {
      const created = await rows.create({ title: 'original' });
      const id = String(created.id);
      await db.query(
        `UPDATE "${TABLE}" SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id],
      );

      const loaded = await loadRow(id);
      loaded.title = 'current-timestamp';
      await expect(loaded.save()).resolves.toBeDefined();
      expect((await loadRow(id)).title).toBe('current-timestamp');
    });

    it('saves a microsecond row through save({ expectedUpdatedAt })', async () => {
      const id = await createRowWithMicrosecondRevision();
      const loaded = await loadRow(id);

      loaded.title = 'expected-guard';
      await expect(
        loaded.save({ expectedUpdatedAt: loaded.updated_at as Date }),
      ).resolves.toBeDefined();
      expect((await loadRow(id)).title).toBe('expected-guard');
    });

    it('claims a microsecond revision without conflicting', async () => {
      const id = await createRowWithMicrosecondRevision();
      const loaded = await loadRow(id);

      await expect(
        loaded.claimRevision(loaded.updated_at as Date),
      ).resolves.toBeDefined();
    });

    it(`saves a microsecond row under TZ=${NON_UTC_ZONE}`, async () => {
      process.env.TZ = NON_UTC_ZONE;
      // `pg` builds the hydrated Date for a `timestamp` column in the process
      // zone. If this runtime does not honour a mid-process TZ change there is
      // nothing to assert.
      if (new Date().getTimezoneOffset() === 0) return;

      const id = await createRowWithMicrosecondRevision();
      const loaded = await loadRow(id);

      loaded.title = 'non-utc';
      await expect(loaded.save()).resolves.toBeDefined();
      expect((await loadRow(id)).title).toBe('non-utc');
    });

    it(`claims a microsecond revision under TZ=${NON_UTC_ZONE}`, async () => {
      process.env.TZ = NON_UTC_ZONE;
      if (new Date().getTimezoneOffset() === 0) return;

      const id = await createRowWithMicrosecondRevision();
      const loaded = await loadRow(id);

      await expect(
        loaded.claimRevision(loaded.updated_at as Date),
      ).resolves.toBeDefined();
    });

    it('still rejects a save whose revision another writer advanced', async () => {
      const id = await createRowWithMicrosecondRevision();
      const loaded = await loadRow(id);

      await db.query(
        `UPDATE "${TABLE}" SET title = 'concurrent', updated_at = CURRENT_TIMESTAMP + interval '5 seconds' WHERE id = $1`,
        [id],
      );

      loaded.title = 'stale';
      await expect(loaded.save()).rejects.toMatchObject({
        code: 'RUNTIME_REVISION_CONFLICT',
      });
      expect((await loadRow(id)).title).toBe('concurrent');
    });

    it('still rejects a save one millisecond behind the stored revision', async () => {
      const id = await createRowWithMicrosecondRevision();
      const loaded = await loadRow(id);

      await db.query(
        `UPDATE "${TABLE}" SET title = 'concurrent', updated_at = updated_at + interval '1 millisecond' WHERE id = $1`,
        [id],
      );

      loaded.title = 'stale';
      await expect(loaded.save()).rejects.toMatchObject({
        code: 'RUNTIME_REVISION_CONFLICT',
      });
      expect((await loadRow(id)).title).toBe('concurrent');
    });

    it('still rejects a claim whose revision another writer advanced', async () => {
      const id = await createRowWithMicrosecondRevision();
      const loaded = await loadRow(id);
      const staleRevision = loaded.updated_at as Date;

      await db.query(
        `UPDATE "${TABLE}" SET updated_at = CURRENT_TIMESTAMP + interval '5 seconds' WHERE id = $1`,
        [id],
      );

      await expect(loaded.claimRevision(staleRevision)).rejects.toMatchObject({
        code: 'RUNTIME_REVISION_CONFLICT',
      });
    });

    it('renders a candidate the database itself matches to the row', async () => {
      const id = await createRowWithMicrosecondRevision();
      const loaded = await loadRow(id);

      const candidates = postgresRevisionCandidates(loaded.updated_at as Date);
      const placeholders = candidates
        .map((_candidate, index) => `$${index + 2}`)
        .join(', ');
      const result = await db.query(
        `SELECT date_trunc('milliseconds', updated_at) IN (${placeholders}) AS matched FROM "${TABLE}" WHERE id = $1`,
        [id, ...candidates],
      );
      expect((result.rows as Array<{ matched: boolean }>)[0].matched).toBe(
        true,
      );
    });
  });
});
