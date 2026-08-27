/**
 * Multi-package PostgreSQL manifest materialization contract for issue #2537.
 *
 * This fixture is assembled from the built commerce and marketing manifests,
 * so the test exercises the same structured schema shipped to consumers. It
 * runs only in the dedicated disposable PostgreSQL shard.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { createIsolatedTestDbFromManifest } from '../test-db.js';

const postgresDescribe = process.env.SMRT_TEST_POSTGRES_URL
  ? describe.sequential
  : describe.skip;

async function dropIssueTables(...tableNames: string[]): Promise<void> {
  const admin = await getDatabase({
    type: 'postgres',
    url: process.env.DATABASE_URL as string,
  });
  try {
    for (const tableName of tableNames) {
      if (!/^i2537_[a-z_]+$/.test(tableName)) {
        throw new Error(`Unsafe issue-table cleanup target: ${tableName}`);
      }
      await admin.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
    }
  } finally {
    await admin.close();
  }
}

postgresDescribe(
  'PostgreSQL multi-package manifest foreign keys (#2537)',
  () => {
    it('converges when concurrent factories add the same deferred cycle constraints', async () => {
      await dropIssueTables('i2537_cycle_a', 'i2537_cycle_b');
      const manifestPath = join(
        tmpdir(),
        `smrt-vitest-issue-2537-cycle-${randomUUID()}.json`,
      );
      const relationship = (table: string) => ({
        type: 'TEXT' as const,
        referenceKind: 'foreignKey' as const,
        foreignKey: {
          table,
          column: 'id',
          onDelete: 'NO ACTION' as const,
          onUpdate: 'CASCADE' as const,
        },
      });
      writeFileSync(
        manifestPath,
        JSON.stringify({
          objects: {
            CycleA: {
              className: 'CycleA',
              schema: {
                tableName: 'i2537_cycle_a',
                columns: {
                  id: { type: 'TEXT', primaryKey: true, notNull: true },
                  b_id: relationship('i2537_cycle_b'),
                },
              },
            },
            CycleB: {
              className: 'CycleB',
              schema: {
                tableName: 'i2537_cycle_b',
                columns: {
                  id: { type: 'TEXT', primaryKey: true, notNull: true },
                  a_id: relationship('i2537_cycle_a'),
                },
              },
            },
          },
        }),
      );

      const createCycleDb = () =>
        createIsolatedTestDbFromManifest({ manifestPath });
      // Both factories start against an empty catalog. PostgreSQL schema
      // preparation must serialize table, index, and deferred-FK creation.
      const [left, right] = await Promise.all([
        createCycleDb(),
        createCycleDb(),
      ]);
      try {
        const result = await left.db.query(
          `SELECT child.relname AS table_name, count(*)::int AS constraint_count
           FROM pg_constraint AS constraint_row
           JOIN pg_class AS child ON child.oid = constraint_row.conrelid
           JOIN pg_namespace AS namespace_row ON namespace_row.oid = child.relnamespace
           WHERE namespace_row.nspname = current_schema()
             AND constraint_row.contype = 'f'
             AND child.relname IN ('i2537_cycle_a', 'i2537_cycle_b')
           GROUP BY child.relname
           ORDER BY child.relname`,
        );
        expect(result.rows).toEqual([
          { table_name: 'i2537_cycle_a', constraint_count: 1 },
          { table_name: 'i2537_cycle_b', constraint_count: 1 },
        ]);
        expect(right.db.isActive()).toBe(true);
      } finally {
        await Promise.all([left.cleanup(), right.cleanup()]);
        rmSync(manifestPath, { force: true });
      }
    });

    it('reconciles an existing table before adding a newly declared relationship', async () => {
      await dropIssueTables(
        'i2537_evolve_child',
        'i2537_evolve_parent',
        'i2537_evolve_parent_alternate',
      );
      const manifestPath = join(
        tmpdir(),
        `smrt-vitest-issue-2537-evolve-${randomUUID()}.json`,
      );
      const baseObjects = {
        Parent: {
          className: 'Parent',
          schema: {
            tableName: 'i2537_evolve_parent',
            columns: {
              id: { type: 'TEXT', primaryKey: true, notNull: true },
            },
          },
        },
        Child: {
          className: 'Child',
          schema: {
            tableName: 'i2537_evolve_child',
            columns: {
              id: { type: 'TEXT', primaryKey: true, notNull: true },
              parent_id: { type: 'TEXT' },
            },
          },
        },
      };
      writeFileSync(manifestPath, JSON.stringify({ objects: baseObjects }));

      const initial = await createIsolatedTestDbFromManifest({ manifestPath });
      await initial.cleanup();

      const relationshipObjects = (
        referencesTable: string,
        onDelete: 'CASCADE' | 'NO ACTION',
      ) => ({
        ...baseObjects,
        ...(referencesTable === 'i2537_evolve_parent_alternate'
          ? {
              ParentAlternate: {
                className: 'ParentAlternate',
                schema: {
                  tableName: 'i2537_evolve_parent_alternate',
                  columns: {
                    id: { type: 'TEXT', primaryKey: true, notNull: true },
                  },
                },
              },
            }
          : {}),
        Child: {
          ...baseObjects.Child,
          schema: {
            ...baseObjects.Child.schema,
            columns: {
              ...baseObjects.Child.schema.columns,
              parent_id: {
                type: 'TEXT',
                referenceKind: 'foreignKey',
                foreignKey: {
                  table: referencesTable,
                  column: 'id',
                  onDelete,
                  onUpdate: 'CASCADE',
                },
              },
              added_later: { type: 'TEXT' },
            },
          },
        },
      });
      const writeObjects = (objects: Record<string, unknown>) =>
        writeFileSync(manifestPath, JSON.stringify({ objects }));
      writeObjects(relationshipObjects('i2537_evolve_parent', 'CASCADE'));

      const readChildConstraints = async (
        db: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>['db'],
      ) => {
        const result = await db.query(
          `SELECT constraint_row.conname AS constraint_name,
                  constraint_row.convalidated,
                  constraint_row.confdeltype,
                  parent.relname AS referenced_table
           FROM pg_constraint AS constraint_row
           JOIN pg_class AS child ON child.oid = constraint_row.conrelid
           JOIN pg_class AS parent ON parent.oid = constraint_row.confrelid
           JOIN pg_namespace AS namespace_row ON namespace_row.oid = child.relnamespace
           WHERE namespace_row.nspname = current_schema()
             AND child.relname = 'i2537_evolve_child'
             AND constraint_row.contype = 'f'
           ORDER BY constraint_row.conname`,
        );
        return result.rows;
      };

      const evolved = await createIsolatedTestDbFromManifest({ manifestPath });
      try {
        const columnResult = await evolved.db.query(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'i2537_evolve_child'
             AND column_name = 'added_later'`,
        );
        expect(columnResult.rows).toEqual([{ column_name: 'added_later' }]);

        expect(await readChildConstraints(evolved.db)).toEqual([
          {
            constraint_name:
              'i2537_evolve_child_parent_id_i2537_evolve_parent_id_fkey',
            convalidated: true,
            confdeltype: 'c',
            referenced_table: 'i2537_evolve_parent',
          },
        ]);

        const parentId = randomUUID();
        await evolved.db.insert('i2537_evolve_parent', { id: parentId });
        await evolved.db.insert('i2537_evolve_child', {
          id: randomUUID(),
          parent_id: parentId,
          added_later: 'reconciled',
        });
        await expect(
          evolved.db.insert('i2537_evolve_child', {
            id: randomUUID(),
            parent_id: randomUUID(),
          }),
        ).rejects.toThrow();
      } finally {
        await evolved.cleanup();
      }

      const partial = await createIsolatedTestDbFromManifest({
        manifestPath,
        includeObjects: ['Child'],
      });
      try {
        expect(await readChildConstraints(partial.db)).toEqual([
          expect.objectContaining({
            referenced_table: 'i2537_evolve_parent',
          }),
        ]);
      } finally {
        await partial.cleanup();
      }

      const admin = await getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
      try {
        await admin.query(
          'ALTER TABLE "i2537_evolve_child" DROP CONSTRAINT "i2537_evolve_child_parent_id_i2537_evolve_parent_id_fkey"',
        );
        await admin.query(
          'ALTER TABLE "i2537_evolve_child" ADD CONSTRAINT "i2537_evolve_child_parent_id_i2537_evolve_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "i2537_evolve_parent" ("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID',
        );
        await admin.query(
          `COMMENT ON CONSTRAINT "i2537_evolve_child_parent_id_i2537_evolve_parent_id_fkey" ON "i2537_evolve_child" IS 'smrt-vitest:manifest-foreign-key:v1'`,
        );
      } finally {
        await admin.close();
      }

      const validated = await createIsolatedTestDbFromManifest({
        manifestPath,
      });
      try {
        expect(await readChildConstraints(validated.db)).toEqual([
          expect.objectContaining({ convalidated: true }),
        ]);
      } finally {
        await validated.cleanup();
      }

      writeObjects(relationshipObjects('i2537_evolve_parent', 'NO ACTION'));
      const actionChanged = await createIsolatedTestDbFromManifest({
        manifestPath,
      });
      try {
        expect(await readChildConstraints(actionChanged.db)).toEqual([
          expect.objectContaining({ confdeltype: 'a' }),
        ]);
      } finally {
        await actionChanged.cleanup();
      }

      writeObjects(
        relationshipObjects('i2537_evolve_parent_alternate', 'CASCADE'),
      );
      const targetChanged = await createIsolatedTestDbFromManifest({
        manifestPath,
      });
      try {
        expect(await readChildConstraints(targetChanged.db)).toEqual([
          expect.objectContaining({
            referenced_table: 'i2537_evolve_parent_alternate',
          }),
        ]);
      } finally {
        await targetChanged.cleanup();
      }

      writeObjects(baseObjects);
      const removed = await createIsolatedTestDbFromManifest({ manifestPath });
      try {
        expect(await readChildConstraints(removed.db)).toEqual([]);
      } finally {
        await removed.cleanup();
        rmSync(manifestPath, { force: true });
      }
    });

    it('preserves unowned constraints and leaves unchanged owned constraints in place', async () => {
      await dropIssueTables('i2537_owned_child', 'i2537_owned_parent');
      const manifestPath = join(
        tmpdir(),
        `smrt-vitest-issue-2537-owned-${randomUUID()}.json`,
      );
      writeFileSync(
        manifestPath,
        JSON.stringify({
          objects: {
            Parent: {
              className: 'Parent',
              schema: {
                tableName: 'i2537_owned_parent',
                columns: {
                  id: { type: 'TEXT', primaryKey: true, notNull: true },
                },
              },
            },
            Child: {
              className: 'Child',
              schema: {
                tableName: 'i2537_owned_child',
                columns: {
                  id: { type: 'TEXT', primaryKey: true, notNull: true },
                  parent_id: {
                    type: 'TEXT',
                    foreignKey: {
                      table: 'i2537_owned_parent',
                      column: 'id',
                      onDelete: 'CASCADE',
                      onUpdate: 'CASCADE',
                    },
                  },
                },
              },
            },
          },
        }),
      );

      const provisioned = await createIsolatedTestDbFromManifest({
        manifestPath,
      });
      await provisioned.cleanup();
      const admin = await getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL as string,
      });
      try {
        await admin.query(
          'COMMENT ON CONSTRAINT "i2537_owned_child_parent_id_i2537_owned_parent_id_fkey" ON "i2537_owned_child" IS NULL',
        );
        await admin.query(
          'ALTER TABLE "i2537_owned_child" ADD CONSTRAINT "external_owned_child_parent_fkey" FOREIGN KEY ("parent_id") REFERENCES "i2537_owned_parent" ("id")',
        );
      } finally {
        await admin.close();
      }

      const beforeDb = await createIsolatedTestDbFromManifest({ manifestPath });
      const before = await beforeDb.db.query(
        `SELECT constraint_row.oid::text AS constraint_oid,
                constraint_row.conname AS constraint_name,
                obj_description(constraint_row.oid, 'pg_constraint') AS ownership_comment
         FROM pg_constraint AS constraint_row
         JOIN pg_class AS child ON child.oid = constraint_row.conrelid
         WHERE child.relname = 'i2537_owned_child'
           AND constraint_row.conname IN (
             'i2537_owned_child_parent_id_i2537_owned_parent_id_fkey',
             'external_owned_child_parent_fkey'
           )
         ORDER BY constraint_row.conname`,
      );
      await beforeDb.cleanup();

      let reopened:
        | Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>
        | undefined;
      try {
        reopened = await createIsolatedTestDbFromManifest({ manifestPath });
        const after = await reopened.db.query(
          `SELECT constraint_row.oid::text AS constraint_oid,
                  constraint_row.conname AS constraint_name,
                  obj_description(constraint_row.oid, 'pg_constraint') AS ownership_comment
           FROM pg_constraint AS constraint_row
           JOIN pg_class AS child ON child.oid = constraint_row.conrelid
           WHERE child.relname = 'i2537_owned_child'
             AND constraint_row.conname IN (
               'i2537_owned_child_parent_id_i2537_owned_parent_id_fkey',
               'external_owned_child_parent_fkey'
             )
           ORDER BY constraint_row.conname`,
        );
        expect(after.rows).toEqual(
          before.rows.map(
            (row: {
              constraint_oid: string;
              constraint_name: string;
              ownership_comment: string | null;
            }) => ({
              ...row,
              ownership_comment:
                row.constraint_name ===
                'i2537_owned_child_parent_id_i2537_owned_parent_id_fkey'
                  ? 'smrt-vitest:manifest-foreign-key:v1'
                  : null,
            }),
          ),
        );
      } finally {
        await reopened?.cleanup();
        rmSync(manifestPath, { force: true });
      }
    });

    it('reopens a legacy cached-DDL manifest with an inline foreign key', async () => {
      await dropIssueTables('i2537_legacy_child', 'i2537_legacy_parent');
      const manifestPath = join(
        tmpdir(),
        `smrt-vitest-issue-2537-legacy-${randomUUID()}.json`,
      );
      writeFileSync(
        manifestPath,
        JSON.stringify({
          objects: {
            Parent: {
              className: 'Parent',
              schema: {
                tableName: 'i2537_legacy_parent',
                ddl: 'CREATE TABLE IF NOT EXISTS "i2537_legacy_parent" ("id" TEXT PRIMARY KEY);',
              },
            },
            Child: {
              className: 'Child',
              schema: {
                tableName: 'i2537_legacy_child',
                ddl: 'CREATE TABLE IF NOT EXISTS "i2537_legacy_child" ("id" TEXT PRIMARY KEY, "parent_id" TEXT, CONSTRAINT "i2537_legacy_child_parent_id_i2537_legacy_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "i2537_legacy_parent" ("id"));',
              },
            },
          },
        }),
      );

      const first = await createIsolatedTestDbFromManifest({ manifestPath });
      await first.cleanup();
      const reopened = await createIsolatedTestDbFromManifest({ manifestPath });
      try {
        const constraints = await reopened.db.query(
          `SELECT constraint_row.convalidated
           FROM pg_constraint AS constraint_row
           JOIN pg_class AS child ON child.oid = constraint_row.conrelid
           WHERE child.relname = 'i2537_legacy_child'
             AND constraint_row.contype = 'f'`,
        );
        expect(constraints.rows).toEqual([{ convalidated: true }]);
        await expect(
          reopened.db.insert('i2537_legacy_child', {
            id: randomUUID(),
            parent_id: randomUUID(),
          }),
        ).rejects.toThrow();
      } finally {
        await reopened.cleanup();
        rmSync(manifestPath, { force: true });
      }
    });

    it('reopens the schema and enforces the shipped campaign relationships', async () => {
      const commerce = JSON.parse(
        readFileSync(resolve('../commerce/dist/manifest.json'), 'utf8'),
      ) as { objects: Record<string, { className?: string }> };
      const marketing = JSON.parse(
        readFileSync(resolve('../marketing/dist/manifest.json'), 'utf8'),
      ) as { objects: Record<string, { className?: string }> };
      const select = (
        manifest: typeof commerce,
        className: string,
      ): [string, (typeof commerce.objects)[string]] => {
        const entry = Object.entries(manifest.objects).find(
          ([, object]) => object.className === className,
        );
        if (!entry) throw new Error(`Built manifest is missing ${className}`);
        return entry;
      };
      const manifestPath = join(
        tmpdir(),
        `smrt-vitest-issue-2537-${randomUUID()}.json`,
      );
      writeFileSync(
        manifestPath,
        JSON.stringify({
          objects: Object.fromEntries([
            select(commerce, 'Customer'),
            select(marketing, 'Campaign'),
            select(marketing, 'CampaignChannel'),
            select(marketing, 'CampaignMetricSnapshot'),
          ]),
        }),
      );

      // The original failure appeared when a later factory synchronized tables
      // whose renderer-owned named constraints already existed. Provision once,
      // close, and then exercise the reopened schema.
      const first = await createIsolatedTestDbFromManifest({ manifestPath });
      await first.cleanup();

      const second = await createIsolatedTestDbFromManifest({ manifestPath });
      try {
        const constraintsResult = await second.db.query(
          `SELECT child.relname AS table_name,
                child_column.attname AS column_name,
                parent.relname AS referenced_table,
                parent_column.attname AS referenced_column,
                constraint_row.confdeltype,
                constraint_row.confupdtype,
                constraint_row.convalidated
         FROM pg_constraint AS constraint_row
         JOIN pg_class AS child ON child.oid = constraint_row.conrelid
         JOIN pg_class AS parent ON parent.oid = constraint_row.confrelid
         JOIN pg_namespace AS namespace_row ON namespace_row.oid = child.relnamespace
         JOIN pg_attribute AS child_column
           ON child_column.attrelid = child.oid
          AND child_column.attnum = constraint_row.conkey[1]
         JOIN pg_attribute AS parent_column
           ON parent_column.attrelid = parent.oid
          AND parent_column.attnum = constraint_row.confkey[1]
         WHERE namespace_row.nspname = current_schema()
           AND constraint_row.contype = 'f'
           AND child.relname IN ('campaign_channels', 'campaign_metric_snapshots')
         ORDER BY child.relname, constraint_row.conname`,
        );
        const constraints = Array.isArray(constraintsResult)
          ? constraintsResult
          : ((constraintsResult as { rows?: unknown[] }).rows ?? []);
        expect(constraints).toEqual([
          {
            table_name: 'campaign_channels',
            column_name: 'campaign_id',
            referenced_table: 'campaigns',
            referenced_column: 'id',
            confdeltype: 'c',
            confupdtype: 'c',
            convalidated: true,
          },
          {
            table_name: 'campaign_metric_snapshots',
            column_name: 'campaign_channel_id',
            referenced_table: 'campaign_channels',
            referenced_column: 'id',
            confdeltype: 'a',
            confupdtype: 'c',
            convalidated: true,
          },
          {
            table_name: 'campaign_metric_snapshots',
            column_name: 'campaign_id',
            referenced_table: 'campaigns',
            referenced_column: 'id',
            confdeltype: 'a',
            confupdtype: 'c',
            convalidated: true,
          },
        ]);

        const tenantId = randomUUID();
        const customerId = randomUUID();
        const campaignId = randomUUID();
        const channelId = randomUUID();
        await second.db.insert('customers', {
          id: customerId,
          slug: `customer-${customerId}`,
          tenant_id: tenantId,
        });
        await second.db.insert('campaigns', {
          id: campaignId,
          slug: `campaign-${campaignId}`,
          tenant_id: tenantId,
          customer_id: customerId,
          campaign_key: `campaign-key-${campaignId}`,
          name: 'Manifest campaign',
        });
        await second.db.insert('campaign_channels', {
          id: channelId,
          slug: `channel-${channelId}`,
          tenant_id: tenantId,
          campaign_id: campaignId,
          channel_kind: 'ad_group',
          channel_ref: `channel-ref-${channelId}`,
        });
        await second.db.insert('campaign_metric_snapshots', {
          id: randomUUID(),
          slug: `snapshot-${randomUUID()}`,
          tenant_id: tenantId,
          campaign_id: campaignId,
          campaign_channel_id: channelId,
          period_start: new Date('2026-08-01T00:00:00.000Z'),
          period_end: new Date('2026-08-02T00:00:00.000Z'),
          source: 'issue-2537',
          dedupe_key: `issue-2537-${randomUUID()}`,
        });

        expect(
          await second.db.get('customers', { id: customerId }),
        ).toBeTruthy();
        expect(
          await second.db.get('campaigns', { id: campaignId }),
        ).toBeTruthy();
        await expect(
          second.db.insert('campaign_channels', {
            id: randomUUID(),
            slug: `orphan-${randomUUID()}`,
            tenant_id: tenantId,
            campaign_id: randomUUID(),
            channel_kind: 'ad_group',
            channel_ref: `orphan-ref-${randomUUID()}`,
          }),
        ).rejects.toThrow();
        await expect(
          second.db.insert('campaign_metric_snapshots', {
            id: randomUUID(),
            slug: `orphan-campaign-${randomUUID()}`,
            tenant_id: tenantId,
            campaign_id: randomUUID(),
            campaign_channel_id: channelId,
            period_start: new Date('2026-08-01T00:00:00.000Z'),
            period_end: new Date('2026-08-02T00:00:00.000Z'),
            source: 'issue-2537',
            dedupe_key: `orphan-campaign-${randomUUID()}`,
          }),
        ).rejects.toThrow();
        await expect(
          second.db.insert('campaign_metric_snapshots', {
            id: randomUUID(),
            slug: `orphan-channel-${randomUUID()}`,
            tenant_id: tenantId,
            campaign_id: campaignId,
            campaign_channel_id: randomUUID(),
            period_start: new Date('2026-08-01T00:00:00.000Z'),
            period_end: new Date('2026-08-02T00:00:00.000Z'),
            source: 'issue-2537',
            dedupe_key: `orphan-channel-${randomUUID()}`,
          }),
        ).rejects.toThrow();
      } finally {
        await second.cleanup();
        rmSync(manifestPath, { force: true });
      }
    });
  },
);
