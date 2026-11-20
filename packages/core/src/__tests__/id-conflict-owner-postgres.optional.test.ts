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
      await getTestDatabase({
        type: 'postgres',
        db,
        classes: ['PgIdConflictOwned'],
      });
    }, 60_000);

    afterAll(async () => {
      await db?.query(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
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
