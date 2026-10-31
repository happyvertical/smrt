/**
 * Tenant-local dedupe keys for campaign metric snapshots (#3305 M2).
 *
 * `campaign_metric_snapshots` was keyed on `(dedupe_key)` installation-wide,
 * but the ingest API takes an opaque caller key and every snapshot is
 * tenant-owned (optional mode: NULL tenant = global evidence). A second
 * tenant filing the same key collided with the first tenant's evidence. The
 * key is now `(tenant_id, dedupe_key)`; the service replay lookup, the
 * race re-read and the model's raw immutability guard all resolve within one
 * owner, including administrative system-context ingests that name a tenant.
 *
 * Runs on the schema generated from the registered models, per engine:
 * SQLite always, PostgreSQL (native UUID tenant columns) when `DATABASE_URL`
 * is set.
 */

import { randomUUID } from 'node:crypto';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  generateSchemaDiff,
  getSQLFromDiff,
} from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CampaignCollection,
  CampaignMetricSnapshotCollection,
} from '../collections/index.js';
import { MetricIngestionService } from '../services/index.js';
import '../index.js';

// DuckDB is not a supported marketing engine: its DDL refuses the
// ON DELETE CASCADE campaign -> channel foreign key.
type Engine = 'sqlite' | 'postgres';
const ENGINES: Engine[] = process.env.DATABASE_URL
  ? ['sqlite', 'postgres']
  : ['sqlite'];

type Row = Record<string, unknown>;
const rowsOf = (result: unknown): Row[] =>
  Array.isArray(result)
    ? (result as Row[])
    : ((result as { rows?: Row[] } | undefined)?.rows ?? []);

describe.each(
  ENGINES,
)('metric snapshot dedupe keys on %s (#3305 M2)', (engine) => {
  let admin: DatabaseInterface | undefined;
  let db: DatabaseInterface;
  let databaseName = '';
  let snapshots: CampaignMetricSnapshotCollection;
  let ingestion: MetricIngestionService;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const inA = <T>(fn: () => Promise<T>) =>
    withTenant({ tenantId: tenantA }, fn);
  const inB = <T>(fn: () => Promise<T>) =>
    withTenant({ tenantId: tenantB }, fn);
  const classes = ['Campaign', 'CampaignChannel', 'CampaignMetricSnapshot'];

  const snapshotRows = async (dedupeKey: string) =>
    rowsOf(
      await db.query(
        'SELECT * FROM campaign_metric_snapshots WHERE dedupe_key = ? ORDER BY created_at, id',
        dedupeKey,
      ),
    );

  const campaignIn = async (tenantId: string | null) => {
    const campaigns = await CampaignCollection.create({ db });
    const run = () =>
      campaigns.create({
        tenantId,
        campaignKey: `campaign-${randomUUID()}`,
        name: 'Campaign',
      });
    const campaign = tenantId
      ? await withTenant({ tenantId }, run)
      : await withSystemContext(run);
    return campaign.id ?? '';
  };

  const input = (
    campaignId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    campaignId,
    periodStart: new Date('2026-07-01T00:00:00Z'),
    periodEnd: new Date('2026-07-01T23:59:59Z'),
    spendCents: 1_000,
    clicks: 10,
    source: 'warehouse-rollup',
    dedupeKey: 'shared-report:2026-07-01',
    ...overrides,
  });

  beforeEach(async () => {
    if (engine === 'postgres') {
      const baseUrl = process.env.DATABASE_URL ?? '';
      admin = await getTestDatabase({
        type: 'postgres',
        url: baseUrl,
        classes: [],
        includeSystemTables: false,
      });
      databaseName = `marketing_keys_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const url = new URL(baseUrl);
      url.pathname = `/${databaseName}`;
      db = await getTestDatabase({
        type: 'postgres',
        url: String(url),
        classes,
      });
    } else {
      db = await getTestDatabase({ type: 'sqlite', url: ':memory:', classes });
    }
    enableTenancy();
    snapshots = await CampaignMetricSnapshotCollection.create({ db });
    ingestion = new MetricIngestionService(snapshots);
  });

  afterEach(async () => {
    disableTenancy();
    await (db as { close?: () => Promise<void> } | undefined)?.close?.();
    if (databaseName) {
      await admin?.query(
        `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
      );
      databaseName = '';
    }
    await (admin as { close?: () => Promise<void> } | undefined)?.close?.();
    admin = undefined;
  });

  it('leads the conflict key and its unique index with tenant_id', () => {
    const schema = ObjectRegistry.getSchema('CampaignMetricSnapshot');
    const unique = (schema?.indexes ?? [])
      .filter((index) => index.unique)
      .map((index) => index.columns);
    expect(unique).toContainEqual(['tenant_id', 'dedupe_key']);
    expect(unique).not.toContainEqual(['dedupe_key']);
  });

  it('files the same key per tenant and replays each owner unchanged', async () => {
    const campaignA = await campaignIn(tenantA);
    const campaignB = await campaignIn(tenantB);
    const a = await inA(() => ingestion.ingest(input(campaignA)));
    const b = await inB(() =>
      ingestion.ingest(input(campaignB, { spendCents: 2_000 })),
    );
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(b.snapshot.id).not.toBe(a.snapshot.id);

    // Same-owner replays return the original evidence, never a rewrite.
    const replayA = await inA(() =>
      ingestion.ingest(input(campaignA, { spendCents: 9_999 })),
    );
    expect(replayA).toMatchObject({ created: false });
    expect(replayA.snapshot.id).toBe(a.snapshot.id);
    expect(replayA.snapshot.spendCents).toBe(1_000);
    const replayB = await ingestion.ingest(
      input(campaignB, { tenantId: tenantB, spendCents: 7 }),
    );
    expect(replayB.snapshot.id).toBe(b.snapshot.id);
    expect(replayB.snapshot.spendCents).toBe(2_000);

    const rows = await snapshotRows('shared-report:2026-07-01');
    expect(
      rows
        .map((row) => [String(row.tenant_id), Number(row.spend_cents)])
        .sort(),
    ).toEqual(
      [
        [tenantA, 1_000],
        [tenantB, 2_000],
      ].sort(),
    );
  });

  it('keeps one global snapshot per key and never replays it for a tenant', async () => {
    const globalCampaign = await campaignIn(null);
    const global = await withSystemContext(() =>
      ingestion.ingest(input(globalCampaign)),
    );
    const globalReplay = await withSystemContext(() =>
      ingestion.ingest(input(globalCampaign, { spendCents: 5 })),
    );
    expect(global.snapshot.tenantId ?? null).toBeNull();
    expect(globalReplay.created).toBe(false);
    expect(globalReplay.snapshot.id).toBe(global.snapshot.id);

    expect(
      await inA(() => snapshots.findByDedupeKey('shared-report:2026-07-01')),
    ).toBeNull();
    const campaignA = await campaignIn(tenantA);
    const tenantRow = await inA(() => ingestion.ingest(input(campaignA)));
    expect(tenantRow.created).toBe(true);
    expect(tenantRow.snapshot.id).not.toBe(global.snapshot.id);
    expect(await snapshotRows('shared-report:2026-07-01')).toHaveLength(2);
  });

  it('routes an administrative system-context ingest to the tenant it names', async () => {
    const campaignB = await campaignIn(tenantB);
    const filed = await withSystemContext(() =>
      ingestion.ingest(input(campaignB, { tenantId: tenantB })),
    );
    expect(filed.snapshot.tenantId).toBe(tenantB);
    const replay = await withSystemContext(() =>
      ingestion.ingest(input(campaignB, { tenantId: tenantB, clicks: 1 })),
    );
    expect(replay.created).toBe(false);
    expect(replay.snapshot.id).toBe(filed.snapshot.id);
    // Without naming the tenant, a system context sees global evidence only.
    expect(
      await withSystemContext(() =>
        snapshots.findByDedupeKey('shared-report:2026-07-01'),
      ),
    ).toBeNull();
  });

  it('fails closed on foreign reads and keeps the raw immutability guard per owner', async () => {
    const campaignA = await campaignIn(tenantA);
    const campaignB = await campaignIn(tenantB);
    const a = await inA(() => ingestion.ingest(input(campaignA)));

    await expect(
      inB(() =>
        snapshots.findByDedupeKey('shared-report:2026-07-01', {
          tenantId: tenantA,
        }),
      ),
    ).rejects.toThrow(/isolation/i);
    await expect(
      inB(() => ingestion.ingest(input(campaignA, { tenantId: tenantA }))),
    ).rejects.toThrow(/isolation/i);

    // A direct create with an existing same-owner key is refused, by context
    // or by an administrative caller naming the owner.
    await expect(
      inA(() => snapshots.create(input(campaignA, { spendCents: 1 }))),
    ).rejects.toThrow(/idempotent ingestion/);
    await expect(
      withSystemContext(() =>
        snapshots.create(
          input(campaignA, { tenantId: tenantA, spendCents: 1 }),
        ),
      ),
    ).rejects.toThrow(/idempotent ingestion/);
    // Another tenant's same key is its own evidence, not a collision.
    const b = await inB(() => snapshots.create(input(campaignB)));
    expect(b.id).not.toBe(a.snapshot.id);

    // Supplying another tenant's snapshot id never rewrites its evidence.
    await expect(
      inB(() =>
        snapshots.create(
          input(campaignB, {
            id: a.snapshot.id,
            _skipLoad: true,
            dedupeKey: 'blind-id-attempt',
            spendCents: 1,
          }),
        ),
      ),
    ).rejects.toThrow();
    const stored = rowsOf(
      await db.query(
        'SELECT spend_cents FROM campaign_metric_snapshots WHERE id = ?',
        a.snapshot.id,
      ),
    );
    expect(Number(stored[0]?.spend_cents)).toBe(1_000);
  });

  it('db:migrate replaces the legacy global dedupe index in place and is then a no-op', async () => {
    const campaignA = await campaignIn(tenantA);
    const campaignB = await campaignIn(tenantB);
    const a = await inA(() => ingestion.ingest(input(campaignA)));
    const before = await snapshotRows('shared-report:2026-07-01');

    await db.query(
      'DROP INDEX IF EXISTS campaign_metric_snapshots_tenant_id_dedupe_key_idx',
    );
    await db.query(
      'CREATE UNIQUE INDEX campaign_metric_snapshots_dedupe_key_idx ON campaign_metric_snapshots (dedupe_key)',
    );
    const schemas = {
      campaign_metric_snapshots:
        ObjectRegistry.getAllSchemasAsDefinitions().campaign_metric_snapshots,
    };
    const diff = await generateSchemaDiff(db, schemas, { engineHint: engine });
    expect(
      diff.changes
        .filter((c) => c.type === 'add_index' || c.type === 'drop_index')
        .map((c) => `${c.type}:${c.name}`)
        .sort(),
    ).toEqual([
      'add_index:campaign_metric_snapshots_tenant_id_dedupe_key_idx',
      'drop_index:campaign_metric_snapshots_dedupe_key_idx',
    ]);
    for (const statement of getSQLFromDiff(diff)) {
      await db.query(statement);
    }

    expect(await snapshotRows('shared-report:2026-07-01')).toEqual(before);
    expect(
      (await inA(() => snapshots.findByDedupeKey('shared-report:2026-07-01')))
        ?.id,
    ).toBe(a.snapshot.id);
    const b = await inB(() => ingestion.ingest(input(campaignB)));
    expect(b.created).toBe(true);
    await expect(
      db.query(
        'INSERT INTO campaign_metric_snapshots (id, slug, context, created_at, updated_at, tenant_id, campaign_id, period_start, period_end, source, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        randomUUID(),
        `dup-${randomUUID()}`,
        '',
        new Date().toISOString(),
        new Date().toISOString(),
        tenantA,
        campaignA,
        new Date('2026-07-01T00:00:00Z').toISOString(),
        new Date('2026-07-01T23:59:59Z').toISOString(),
        'raw',
        'shared-report:2026-07-01',
      ),
    ).rejects.toThrow(/unique|duplicate|constraint/i);

    const again = await generateSchemaDiff(db, schemas, { engineHint: engine });
    expect(
      again.changes.filter(
        (c) => c.type === 'add_index' || c.type === 'drop_index',
      ),
    ).toEqual([]);
  });
});
