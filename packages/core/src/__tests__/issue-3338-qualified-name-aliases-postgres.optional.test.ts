/**
 * PostgreSQL proof for stored references under a moved class's old qualified
 * name (#3338).
 *
 * Runs only in the disposable PostgreSQL shard. Beyond the SQLite suite it
 * proves the doctor count and the backfill's correlated duplicate guard
 * (`IS NOT DISTINCT FROM`) bind and run against native `uuid` id/tenant
 * columns inside a real transaction.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { BackfillTracker } from '../migrations/backfill-tracker';
import {
  backfillLegacyQualifiedNames,
  countLegacyQualifiedNameReferences,
  LEGACY_QUALIFIED_NAMES_BACKFILL_PREFIX,
} from '../migrations/qualified-name-aliases';
import { SmrtObject } from '../object';
import { SmrtPolymorphicAssociation } from '../polymorphic-association';
import { ObjectRegistry, smrt } from '../registry';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

const OLD = '@legacy-3338/old-owner:I3338PgMovedTarget';
const TARGETS_TABLE = 'pg_3338_moved_targets';
const LINKS_TABLE = 'pg_3338_links';

@smrt({
  tableName: 'pg_3338_moved_targets',
  previousQualifiedNames: ['@legacy-3338/old-owner:I3338PgMovedTarget'],
})
class I3338PgMovedTarget extends SmrtObject {
  name = '';
}

@smrt()
class I3338PgMovedTargetCollection extends SmrtCollection<I3338PgMovedTarget> {
  static readonly _itemClass = I3338PgMovedTarget;
}

@smrt({
  tableName: 'pg_3338_links',
  conflictColumns: ['tenant_id', 'owner_key', 'meta_type', 'meta_id', 'role'],
})
class I3338PgLink extends SmrtPolymorphicAssociation {
  tenantId = '';
  ownerKey = '';
}

@smrt()
class I3338PgLinkCollection extends SmrtCollection<I3338PgLink> {
  static readonly _itemClass = I3338PgLink;
}

describe.skipIf(!pgUrl)(
  'stored references under a moved class’s old name on PostgreSQL (#3338)',
  () => {
    let db: DatabaseInterface;
    let targets: I3338PgMovedTargetCollection;
    let links: I3338PgLinkCollection;
    let current: string;

    async function createTable(ctor: typeof SmrtObject): Promise<void> {
      const registration = ObjectRegistry.getClassByConstructor(ctor);
      const className =
        registration?.qualifiedName || registration?.name || ctor.name;
      const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
      if (!ddl) throw new Error(`Missing schema DDL for ${className}`);
      await db.query(ddl);
    }

    async function clearMarkers(): Promise<void> {
      await new BackfillTracker({ db }).initialize();
      await db.query(
        'DELETE FROM _smrt_backfills WHERE name LIKE ?',
        `${LEGACY_QUALIFIED_NAMES_BACKFILL_PREFIX}:%`,
      );
    }

    beforeAll(async () => {
      db = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-3338-${randomUUID()}`,
        max: 4,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      for (const table of [LINKS_TABLE, TARGETS_TABLE]) {
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
      }
      await createTable(I3338PgMovedTarget as unknown as typeof SmrtObject);
      await createTable(I3338PgLink as unknown as typeof SmrtObject);
      await db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${TARGETS_TABLE}_natural_uq" ON "${TARGETS_TABLE}" (slug, context)`,
      );
      await db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${LINKS_TABLE}_natural_uq" ` +
          `ON "${LINKS_TABLE}" (tenant_id, owner_key, meta_type, meta_id, role)`,
      );
      current = ObjectRegistry.getClassByConstructor(
        I3338PgMovedTarget as unknown as typeof SmrtObject,
      )?.qualifiedName as string;
    }, 60_000);

    afterAll(async () => {
      if (!db) return;
      try {
        await clearMarkers();
        for (const table of [LINKS_TABLE, TARGETS_TABLE]) {
          await db.query(`DROP TABLE IF EXISTS "${table}"`);
        }
      } finally {
        await db.close?.();
      }
    });

    beforeEach(async () => {
      await db.query(`TRUNCATE "${LINKS_TABLE}", "${TARGETS_TABLE}"`);
      await clearMarkers();
      targets = await I3338PgMovedTargetCollection.create({ db });
      links = await I3338PgLinkCollection.create({ db });
    });

    async function makeTarget(name: string): Promise<I3338PgMovedTarget> {
      const target = await targets.create({ name } as never);
      await target.save();
      return target;
    }

    async function legacyLink(
      target: I3338PgMovedTarget,
      tenantId: string,
      ownerKey: string,
    ): Promise<I3338PgLink> {
      const link = await links.create({
        tenantId,
        ownerKey,
        metaType: current,
        metaId: target.id,
        role: 'hero',
      } as never);
      await link.save();
      await db.query(
        `UPDATE "${LINKS_TABLE}" SET meta_type = ? WHERE id = ?`,
        OLD,
        link.id,
      );
      return link;
    }

    async function rows(): Promise<Array<Record<string, unknown>>> {
      return (
        await db.query(
          `SELECT tenant_id::text AS tenant_id, owner_key, meta_type FROM "${LINKS_TABLE}" ORDER BY owner_key`,
        )
      ).rows as Array<Record<string, unknown>>;
    }

    it('hydrates under the old metaType and stores the current name on save', async () => {
      const target = await makeTarget('pg-legacy');
      const tenant = randomUUID();
      const seeded = await legacyLink(target, tenant, 'a');

      const reloaded = (await links.get({ id: seeded.id })) as I3338PgLink;
      expect(reloaded.metaType).toBe(OLD);
      const hydrated = await reloaded.hydrate<I3338PgMovedTarget>();
      expect(hydrated?.id).toBe(target.id);
      expect(hydrated?.name).toBe('pg-legacy');

      await reloaded.save();
      expect(await rows()).toEqual([
        { tenant_id: tenant, owner_key: 'a', meta_type: current },
      ]);
    });

    it('counts, then backfills tenant-scoped, globally, idempotently', async () => {
      const target = await makeTarget('pg-backfill');
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      await legacyLink(target, tenantA, 'a');
      await legacyLink(target, tenantB, 'b');

      const before = await countLegacyQualifiedNameReferences(db);
      expect(
        before.references.filter((entry) => entry.table === LINKS_TABLE),
      ).toEqual([
        {
          table: LINKS_TABLE,
          column: 'meta_type',
          kind: 'polymorphic',
          alias: OLD,
          current,
          count: 2,
        },
      ]);

      const scoped = await backfillLegacyQualifiedNames(db, {
        tenantId: tenantA,
      });
      expect(scoped.ran).toBe(true);
      expect(await rows()).toEqual([
        { tenant_id: tenantA, owner_key: 'a', meta_type: current },
        { tenant_id: tenantB, owner_key: 'b', meta_type: OLD },
      ]);

      const global = await backfillLegacyQualifiedNames(db);
      expect(global.ran).toBe(true);
      expect(global.recorded).toBe(true);
      expect((await rows()).map((row) => row.meta_type)).toEqual([
        current,
        current,
      ]);
      expect((await backfillLegacyQualifiedNames(db)).ran).toBe(false);
    });

    it('skips a rewrite that would duplicate a current-name row', async () => {
      const target = await makeTarget('pg-duplicate');
      const tenant = randomUUID();
      await legacyLink(target, tenant, 'same');
      const duplicate = await links.create({
        tenantId: tenant,
        ownerKey: 'same',
        metaType: current,
        metaId: target.id,
        role: 'hero',
      } as never);
      await duplicate.save();

      const result = await backfillLegacyQualifiedNames(db);
      expect(result.recorded).toBe(false);
      expect(
        result.skippedDuplicates.filter((entry) => entry.table === LINKS_TABLE),
      ).toEqual([expect.objectContaining({ alias: OLD, count: 1 })]);
      expect((await rows()).map((row) => row.meta_type).sort()).toEqual(
        [current, OLD].sort(),
      );
    });

    it('deleting the target removes association rows stored under either name', async () => {
      const target = await makeTarget('pg-doomed');
      const tenant = randomUUID();
      await legacyLink(target, tenant, 'legacy');
      const fresh = await links.create({
        tenantId: tenant,
        ownerKey: 'fresh',
        metaType: current,
        metaId: target.id,
      } as never);
      await fresh.save();

      await target.delete();
      expect(await rows()).toEqual([]);
    });
  },
);
