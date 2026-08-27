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
import { describe, expect, it } from 'vitest';
import { createIsolatedTestDbFromManifest } from '../test-db.js';

const postgresDescribe = process.env.SMRT_TEST_POSTGRES_URL
  ? describe.sequential
  : describe.skip;

interface BuiltManifest {
  objects: Record<string, { className?: string }>;
}

function readBuiltManifest(path: string): BuiltManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as BuiltManifest;
}

function selectObject(
  manifest: BuiltManifest,
  className: string,
): [string, BuiltManifest['objects'][string]] {
  const entry = Object.entries(manifest.objects).find(
    ([, object]) => object.className === className,
  );
  if (!entry) {
    throw new Error(
      `Built manifest is missing ${className}; build commerce and marketing before the PostgreSQL lane`,
    );
  }
  return entry;
}

postgresDescribe(
  'PostgreSQL multi-package manifest foreign keys (#2537)',
  () => {
    it('converges when concurrent factories add the same deferred cycle constraints', async () => {
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
      const seed = await createCycleDb();
      try {
        // Leave the tables in place but remove both planner-deferred
        // constraints so concurrent factories race on ADD CONSTRAINT rather
        // than short-circuiting on the preflight existence check.
        await seed.baseDb.query(
          'ALTER TABLE "i2537_cycle_a" DROP CONSTRAINT "i2537_cycle_a_b_id_i2537_cycle_b_id_fkey"',
        );
        await seed.baseDb.query(
          'ALTER TABLE "i2537_cycle_b" DROP CONSTRAINT "i2537_cycle_b_a_id_i2537_cycle_a_id_fkey"',
        );
      } finally {
        await seed.cleanup();
      }

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

    it('reopens the schema and enforces the shipped campaign relationships', async () => {
      const commerce = readBuiltManifest(
        resolve('../commerce/dist/manifest.json'),
      );
      const marketing = readBuiltManifest(
        resolve('../marketing/dist/manifest.json'),
      );
      const objects = Object.fromEntries([
        selectObject(commerce, 'Customer'),
        selectObject(marketing, 'Campaign'),
        selectObject(marketing, 'CampaignChannel'),
        selectObject(marketing, 'CampaignMetricSnapshot'),
      ]);
      const manifestPath = join(
        tmpdir(),
        `smrt-vitest-issue-2537-${randomUUID()}.json`,
      );
      writeFileSync(manifestPath, JSON.stringify({ objects }));

      // The original failure appeared when a later factory synchronized tables
      // whose renderer-owned named constraints already existed. Provision once,
      // close, and then exercise the reopened schema.
      const first = await createIsolatedTestDbFromManifest({ manifestPath });
      await first.cleanup();

      const second = await createIsolatedTestDbFromManifest({ manifestPath });
      try {
        const constraintsResult = await second.db.query(
          `SELECT child.relname AS table_name,
                constraint_row.conname AS constraint_name
         FROM pg_constraint AS constraint_row
         JOIN pg_class AS child ON child.oid = constraint_row.conrelid
         JOIN pg_namespace AS namespace_row ON namespace_row.oid = child.relnamespace
         WHERE namespace_row.nspname = current_schema()
           AND constraint_row.contype = 'f'
           AND child.relname IN ('campaign_channels', 'campaign_metric_snapshots')
         ORDER BY child.relname, constraint_row.conname`,
        );
        const constraints = Array.isArray(constraintsResult)
          ? constraintsResult
          : ((constraintsResult as { rows?: unknown[] }).rows ?? []);
        expect(constraints).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              table_name: 'campaign_channels',
              constraint_name:
                'campaign_channels_campaign_id_campaigns_id_fkey',
            }),
            expect.objectContaining({
              table_name: 'campaign_metric_snapshots',
              constraint_name:
                'campaign_metric_snapshots_campaign_id_campaigns_id_fkey',
            }),
            expect.objectContaining({
              table_name: 'campaign_metric_snapshots',
              constraint_name:
                'campaign_metric_snapshots_campaign_channel_id_campai_beeca5aa9b',
            }),
          ]),
        );

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
      } finally {
        await second.cleanup();
        rmSync(manifestPath, { force: true });
      }
    });
  },
);
