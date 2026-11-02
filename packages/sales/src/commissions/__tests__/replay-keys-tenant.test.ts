/**
 * Tenant-local replay keys for earning events, commissions and payouts
 * (#3305 D1).
 *
 * The three keys were installation-wide (`dedupe_key`, `dedupe_key`,
 * `idempotency_key`) on tenant-owned rows, relying on callers to embed the
 * tenant. They are now `(tenant_id, key)`. Every replay lookup and raw guard
 * resolves one owner (explicit tenant, else context, else global); the
 * calculation and payout services pass the event's / earner's tenant, since
 * they run without a context. Same-owner replays, the commission lifecycle
 * and the payout retry fences are unchanged; a foreign owner fails closed.
 *
 * Runs on the schema generated from the registered models: SQLite always,
 * PostgreSQL (native UUID tenant columns) when `DATABASE_URL` is set.
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
  withSuperAdminBypass,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { CommissionPayoutCollection } from '../collections/CommissionPayoutCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import { EarningEventCollection } from '../collections/EarningEventCollection.js';
import { CommissionCalculationService } from '../services/CommissionCalculationService.js';
import { CommissionPayoutService } from '../services/CommissionPayoutService.js';

type Engine = 'sqlite' | 'postgres';
const ENGINES: Engine[] = process.env.DATABASE_URL
  ? ['sqlite', 'postgres']
  : ['sqlite'];

const KEYS = {
  earning_events: 'dedupe_key',
  commissions: 'dedupe_key',
  commission_payouts: 'idempotency_key',
} as const;

type Row = Record<string, unknown>;
const rowsOf = (result: unknown): Row[] =>
  Array.isArray(result)
    ? (result as Row[])
    : ((result as { rows?: Row[] } | undefined)?.rows ?? []);

describe.each(ENGINES)('sales replay keys on %s (#3305 D1)', (engine) => {
  let admin: DatabaseInterface | undefined;
  let db: DatabaseInterface;
  let databaseName = '';
  let events: EarningEventCollection;
  let commissions: CommissionCollection;
  let payouts: CommissionPayoutCollection;
  let earners: EarnerCollection;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const inA = <T>(fn: () => Promise<T>) =>
    withTenant({ tenantId: tenantA }, fn);
  const inB = <T>(fn: () => Promise<T>) =>
    withTenant({ tenantId: tenantB }, fn);

  const rowsWith = async (table: string, column: string, value: string) =>
    rowsOf(
      await db.query(
        `SELECT * FROM ${table} WHERE ${column} = ? ORDER BY created_at, id`,
        value,
      ),
    );

  const eventInput = (overrides: Record<string, unknown> = {}) => ({
    eventKind: 'invoice_payment',
    occurredAt: new Date('2026-03-15T12:00:00Z'),
    sourceKind: 'agreement',
    sourceId: 'agr-1',
    grossAmountCents: 10_000,
    currency: 'USD',
    dedupeKey: 'invoice:42:paid',
    ...overrides,
  });

  const earnerIn = (tenantId: string) =>
    withTenant({ tenantId }, () =>
      earners.create({
        profileId: randomUUID(),
        displayName: 'Casey Rep',
        status: 'active',
        payoutThresholdCents: 0,
        payoutMethod: 'paypal',
      }),
    );

  beforeEach(async () => {
    if (engine === 'postgres') {
      const baseUrl = process.env.DATABASE_URL ?? '';
      admin = await getTestDatabase({
        type: 'postgres',
        url: baseUrl,
        classes: [],
        includeSystemTables: false,
      });
      databaseName = `sales_keys_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const url = new URL(baseUrl);
      url.pathname = `/${databaseName}`;
      db = await getTestDatabase({ type: 'postgres', url: String(url) });
    } else {
      db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    }
    enableTenancy();
    events = await EarningEventCollection.create({ db });
    commissions = await CommissionCollection.create({ db });
    payouts = await CommissionPayoutCollection.create({ db });
    earners = await EarnerCollection.create({ db });
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

  it('leads every replay key and its unique index with tenant_id', () => {
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    for (const [table, column] of Object.entries(KEYS)) {
      const unique = (schemas[table]?.indexes ?? [])
        .filter((index) => index.unique)
        .map((index) => index.columns);
      expect(unique, table).toContainEqual(['tenant_id', column]);
      expect(unique, table).not.toContainEqual([column]);
    }
  });

  describe('earning events', () => {
    it('ingests the same key per tenant and replays each owner unchanged', async () => {
      const a = await inA(() => events.getOrCreateByDedupeKey(eventInput()));
      const b = await inB(() =>
        events.getOrCreateByDedupeKey(eventInput({ grossAmountCents: 7 })),
      );
      expect(a.created && b.created).toBe(true);
      expect(b.event.id).not.toBe(a.event.id);

      const replay = await inA(() =>
        events.getOrCreateByDedupeKey(eventInput({ grossAmountCents: 1 })),
      );
      expect(replay.created).toBe(false);
      expect(replay.event.id).toBe(a.event.id);
      expect(replay.event.grossAmountCents).toBe(10_000);
      // An administrative caller names the owner; unnamed it sees globals.
      const adminReplay = await withSystemContext(() =>
        events.getOrCreateByDedupeKey(eventInput({ tenantId: tenantB })),
      );
      expect(adminReplay.event.id).toBe(b.event.id);
      expect(
        await withSystemContext(() =>
          events.findByDedupeKey('invoice:42:paid'),
        ),
      ).toBeNull();
      expect(
        await rowsWith('earning_events', 'dedupe_key', 'invoice:42:paid'),
      ).toHaveLength(2);
    });

    it('keeps one global event per key and never replays it for a tenant', async () => {
      const g = await withSystemContext(() =>
        events.getOrCreateByDedupeKey(eventInput()),
      );
      const gRetry = await withSystemContext(() =>
        events.getOrCreateByDedupeKey(eventInput()),
      );
      expect(gRetry.created).toBe(false);
      expect(gRetry.event.id).toBe(g.event.id);
      expect(
        await inA(() => events.findByDedupeKey('invoice:42:paid')),
      ).toBeNull();
    });

    it('fails closed on foreign owners, including under super-admin bypass', async () => {
      await inB(() => events.getOrCreateByDedupeKey(eventInput()));
      for (const run of [
        () =>
          inA(() =>
            events.findByDedupeKey('invoice:42:paid', { tenantId: tenantB }),
          ),
        () =>
          inA(() =>
            withSuperAdminBypass(() =>
              events.findByDedupeKey('invoice:42:paid', { tenantId: tenantB }),
            ),
          ),
        // Refused before the raw dedupe guard, whether or not B filed it.
        () => inA(() => events.create(eventInput({ tenantId: tenantB }))),
        () =>
          inA(() =>
            events.create(
              eventInput({ tenantId: tenantB, dedupeKey: 'never' }),
            ),
          ),
      ]) {
        await expect(run()).rejects.toThrow(/isolation/i);
      }
      // The same owner cannot overwrite through a direct create.
      await expect(
        inB(() => events.create(eventInput({ grossAmountCents: 1 }))),
      ).rejects.toThrow(/immutable evidence/);
    });
  });

  describe('commissions', () => {
    it('calculates per tenant from same-key events and replays without a context', async () => {
      const earnerA = await earnerIn(tenantA);
      const earnerB = await earnerIn(tenantB);
      const eventA = (
        await inA(() => events.getOrCreateByDedupeKey(eventInput()))
      ).event;
      const eventB = (
        await inB(() => events.getOrCreateByDedupeKey(eventInput()))
      ).event;
      const service = new CommissionCalculationService(commissions);
      const input = (event: typeof eventA, earnerId: string) => ({
        event,
        planKey: 'plan-a',
        planVersion: 1,
        components: [
          { key: 'on-gross', trigger: '*', basis: 'gross' as const, rate: 0.1 },
        ],
        earnerId,
      });
      // Background calculation: no tenant context.
      const a = await service.calculateForEvent(
        input(eventA, earnerA.id ?? ''),
      );
      const b = await service.calculateForEvent(
        input(eventB, earnerB.id ?? ''),
      );
      expect(a.created).toHaveLength(1);
      expect(b.created).toHaveLength(1);
      // Both derive from the same event key in their own tenant.
      expect(a.created[0]?.dedupeKey.startsWith('invoice:42:paid:')).toBe(true);
      expect(b.created[0]?.dedupeKey.startsWith('invoice:42:paid:')).toBe(true);
      expect(a.created[0]?.id).not.toBe(b.created[0]?.id);
      expect(a.created[0]?.tenantId).toBe(tenantA);
      expect(b.created[0]?.tenantId).toBe(tenantB);

      const replay = await service.calculateForEvent(
        input(eventA, earnerA.id ?? ''),
      );
      expect(replay.created).toEqual([]);
      expect(replay.existing.map((row) => row.id)).toEqual([a.created[0]?.id]);
      const key = a.created[0]?.dedupeKey ?? '';
      // Tenant B may hold A's exact commission key as its own row.
      const twin = await inB(() =>
        commissions.create({
          earnerId: earnerB.id ?? '',
          amountCents: 1,
          currency: 'USD',
          dedupeKey: key,
        }),
      );
      expect(twin.id).not.toBe(a.created[0]?.id);
      expect(await rowsWith('commissions', 'dedupe_key', key)).toHaveLength(2);
      // The same owner's key is still fenced against a direct overwrite.
      await expect(
        inA(() =>
          commissions.create({
            earnerId: earnerA.id ?? '',
            amountCents: 1,
            currency: 'USD',
            dedupeKey: key,
          }),
        ),
      ).rejects.toThrow(/immutable audit rows/);
      await expect(
        inA(() => commissions.findByDedupeKey(key, { tenantId: tenantB })),
      ).rejects.toThrow(/isolation/i);
    });
  });

  describe('payouts', () => {
    it('settles the same idempotency key per tenant and replays each owner', async () => {
      const service = new CommissionPayoutService({
        earners,
        commissions,
        adjustments: await CommissionAdjustmentCollection.create({ db }),
        payouts,
      });
      const earnerA = await earnerIn(tenantA);
      const earnerB = await earnerIn(tenantB);
      for (const [tenantId, earner] of [
        [tenantA, earnerA],
        [tenantB, earnerB],
      ] as const) {
        await withTenant({ tenantId }, () =>
          commissions.create({
            earnerId: earner.id ?? '',
            amountCents: 2_500,
            currency: 'USD',
            status: 'payable',
            dedupeKey: `payable-${tenantId}`,
          }),
        );
      }
      const batch = (earnerId: string) => ({
        earnerId,
        currency: 'USD',
        idempotencyKey: 'march-close',
      });
      // Background settlement: no tenant context.
      const a = await service.createPayoutBatch(batch(earnerA.id ?? ''));
      const b = await service.createPayoutBatch(batch(earnerB.id ?? ''));
      expect(a.created && b.created).toBe(true);
      expect(b.payout?.id).not.toBe(a.payout?.id);
      expect(a.payout?.tenantId).toBe(tenantA);
      expect(b.payout?.tenantId).toBe(tenantB);
      expect(a.payout?.totalAmountCents).toBe(2_500);

      const replay = await service.createPayoutBatch(batch(earnerA.id ?? ''));
      expect(replay.created).toBe(false);
      expect(replay.payout?.id).toBe(a.payout?.id);
      expect(replay.settledCommissionIds).toEqual([]);
      expect(
        await rowsWith('commission_payouts', 'idempotency_key', 'march-close'),
      ).toHaveLength(2);
      await expect(
        inA(() =>
          payouts.findByIdempotencyKey('march-close', { tenantId: tenantB }),
        ),
      ).rejects.toThrow(/isolation/i);
      // The routing guard still refuses a second payout under the same
      // owner's key.
      await expect(
        payouts.create({
          tenantId: tenantA,
          earnerId: earnerA.id ?? '',
          currency: 'USD',
          status: 'pending',
          idempotencyKey: 'march-close',
        }),
      ).rejects.toThrow();
    });
  });

  it('db:migrate replaces the legacy global replay indexes in place and is then a no-op', async () => {
    const a = await inA(() => events.getOrCreateByDedupeKey(eventInput()));
    const before = await rowsWith(
      'earning_events',
      'dedupe_key',
      'invoice:42:paid',
    );
    for (const [table, column] of Object.entries(KEYS)) {
      await db.query(`DROP INDEX IF EXISTS ${table}_tenant_id_${column}_idx`);
      await db.query(
        `CREATE UNIQUE INDEX ${table}_${column}_idx ON ${table} (${column})`,
      );
    }
    const all = ObjectRegistry.getAllSchemasAsDefinitions();
    const schemas = Object.fromEntries(
      Object.keys(KEYS).map((table) => [table, all[table]]),
    );
    const diff = await generateSchemaDiff(db, schemas, { engineHint: engine });
    expect(
      diff.changes
        .filter((c) => c.type === 'add_index' || c.type === 'drop_index')
        .map((c) => `${c.type}:${c.name}`)
        .sort(),
    ).toEqual(
      Object.entries(KEYS)
        .flatMap(([table, column]) => [
          `add_index:${table}_tenant_id_${column}_idx`,
          `drop_index:${table}_${column}_idx`,
        ])
        .sort(),
    );
    for (const statement of getSQLFromDiff(diff)) {
      await db.query(statement);
    }
    expect(
      await rowsWith('earning_events', 'dedupe_key', 'invoice:42:paid'),
    ).toEqual(before);
    expect(
      (await inA(() => events.findByDedupeKey('invoice:42:paid')))?.id,
    ).toBe(a.event.id);
    const b = await inB(() => events.getOrCreateByDedupeKey(eventInput()));
    expect(b.created).toBe(true);
    const again = await generateSchemaDiff(db, schemas, { engineHint: engine });
    expect(
      again.changes.filter(
        (c) => c.type === 'add_index' || c.type === 'drop_index',
      ),
    ).toEqual([]);
  });
});
