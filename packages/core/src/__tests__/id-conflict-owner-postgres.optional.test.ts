/**
 * PostgreSQL: an explicit-id create on an `['id']` conflict target writes
 * through `INSERT … ON CONFLICT (id) DO UPDATE … WHERE <same owner>`, so a
 * stored row owned by another tenant (or a global row for a tenant's save,
 * and the reverse) is never rewritten; the save is refused with
 * `TENANT_ISOLATION_VIOLATION`. The embedded engines are covered by
 * `id-conflict-owner.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators/index';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';
const TABLE = 'pg_id_conflict_owned';

@smrt({ tableName: 'pg_id_conflict_owned', conflictColumns: ['id'] })
class PgIdConflictOwned extends SmrtObject {
  @field({ type: 'text' }) body = '';
  @field({ type: 'text' }) tenantId: string | null = null;
}
class PgIdConflictOwnedCollection extends SmrtCollection<PgIdConflictOwned> {
  static readonly _itemClass = PgIdConflictOwned;
}

@smrt({ tableName: 'pg_id_conflict_plain', conflictColumns: ['id'] })
class PgIdConflictPlain extends SmrtObject {
  @field({ type: 'text' }) body = '';
}
class PgIdConflictPlainCollection extends SmrtCollection<PgIdConflictPlain> {
  static readonly _itemClass = PgIdConflictPlain;
}

/** Whether `transformJSON()` drops the owner column from the saved row. */
let dropOwner = false;

@smrt({ tableName: 'pg_id_conflict_dropping', conflictColumns: ['id'] })
class PgIdConflictDropping extends SmrtObject {
  @field({ type: 'text' }) body = '';
  @field({ type: 'text' }) tenantId: string | null = null;

  protected override transformJSON(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!dropOwner) return data;
    const { tenantId: _omitted, ...rest } = data;
    return rest;
  }
}
class PgIdConflictDroppingCollection extends SmrtCollection<PgIdConflictDropping> {
  static readonly _itemClass = PgIdConflictDropping;
}

describe.skipIf(!pgUrl)(
  'explicit-id create on an id conflict target [postgres]',
  () => {
    let db: DatabaseInterface;
    let owned: PgIdConflictOwnedCollection;

    beforeAll(async () => {
      db = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `id-conflict-owner-${randomUUID()}`,
        max: 4,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      await db.query(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
      await db.query(`DROP TABLE IF EXISTS "pg_id_conflict_dropping" CASCADE`);
      await db.query(`DROP TABLE IF EXISTS "pg_id_conflict_plain" CASCADE`);
      await getTestDatabase({
        type: 'postgres',
        db,
        classes: [
          'PgIdConflictOwned',
          'PgIdConflictDropping',
          'PgIdConflictPlain',
        ],
      });
    }, 60_000);

    afterAll(async () => {
      await db?.query(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
      await db?.query(`DROP TABLE IF EXISTS "pg_id_conflict_dropping" CASCADE`);
      await db?.query(`DROP TABLE IF EXISTS "pg_id_conflict_plain" CASCADE`);
      await db?.close?.();
    });

    beforeEach(async () => {
      await db.query(`TRUNCATE "${TABLE}"`);
      owned = await PgIdConflictOwnedCollection.create({ db });
    });

    async function stored(id: string) {
      const result = await db.query(
        `SELECT body, CAST(tenant_id AS VARCHAR) AS tenant_id FROM "${TABLE}" WHERE id = $1`,
        id,
      );
      return result.rows[0];
    }

    it("refuses a create that names another tenant's row id", async () => {
      const a = await owned.create({ body: 'A', tenantId: TENANT_A } as never);

      await expect(
        owned.create({ id: a.id, body: 'B', tenantId: TENANT_B } as never),
      ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });

      expect(await stored(String(a.id))).toEqual({
        body: 'A',
        tenant_id: TENANT_A,
      });
    });

    it("refuses a global create that names a tenant's row id", async () => {
      const a = await owned.create({ body: 'A', tenantId: TENANT_A } as never);

      await expect(
        owned.create({ id: a.id, body: 'global' } as never),
      ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });

      expect(await stored(String(a.id))).toEqual({
        body: 'A',
        tenant_id: TENANT_A,
      });
    });

    it('refuses a create whose saved row leaves the owner column out', async () => {
      await db.query('TRUNCATE "pg_id_conflict_dropping"');
      const dropping = await PgIdConflictDroppingCollection.create({ db });
      const a = await dropping.create({
        body: 'A',
        tenantId: TENANT_A,
      } as never);

      dropOwner = true;
      try {
        await expect(
          dropping.create({
            id: a.id,
            body: 'B',
            tenantId: TENANT_B,
          } as never),
        ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });
      } finally {
        dropOwner = false;
      }

      const result = await db.query(
        'SELECT body, CAST(tenant_id AS VARCHAR) AS tenant_id FROM "pg_id_conflict_dropping" WHERE id = $1',
        String(a.id),
      );
      expect(result.rows[0]).toEqual({ body: 'A', tenant_id: TENANT_A });
    });

    it('control: a model without an owner column still updates by id', async () => {
      await db.query('TRUNCATE "pg_id_conflict_plain"');
      const plain = await PgIdConflictPlainCollection.create({ db });
      const a = await plain.create({ body: 'A' } as never);

      await plain.create({ id: a.id, body: 'A again' } as never);

      const result = await db.query(
        'SELECT body FROM "pg_id_conflict_plain" WHERE id = $1',
        String(a.id),
      );
      expect(result.rows[0]).toEqual({ body: 'A again' });
    });

    it('control: a same-tenant create with the id updates the row in place', async () => {
      const a = await owned.create({ body: 'A', tenantId: TENANT_A } as never);

      await owned.create({
        id: a.id,
        body: 'A again',
        tenantId: TENANT_A,
      } as never);

      expect(await stored(String(a.id))).toEqual({
        body: 'A again',
        tenant_id: TENANT_A,
      });
    });
  },
);
