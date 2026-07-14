/**
 * Tests for the source-scoped payout history (#1985): the derived
 * single-source stamp maintained by createPayoutBatch/claimAndReconcile,
 * `getSourcePayoutHistory` pagination (newest-first, deterministic,
 * fail-closed membership verification, adjustment-only payouts, mixed-source
 * rejection), bounded query work for sparse sources, and the
 * `restampPayoutSource` backfill for pre-stamp payouts.
 *
 * Real in-memory SQLite — no mocks of database operations.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { CommissionPayoutCollection } from '../collections/CommissionPayoutCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import type { Commission } from '../models/Commission.js';
import type { CommissionPayout } from '../models/CommissionPayout.js';
import type { Earner } from '../models/Earner.js';
import { CommissionPayoutService } from '../services/CommissionPayoutService.js';

const NETWORK_A = { sourceKind: 'ad_network', sourceId: 'net-a' };
const NETWORK_B = { sourceKind: 'ad_network', sourceId: 'net-b' };

describe('Source-scoped payout history (#1985)', () => {
  let db: DatabaseInterface;
  let earners: EarnerCollection;
  let commissions: CommissionCollection;
  let adjustments: CommissionAdjustmentCollection;
  let payouts: CommissionPayoutCollection;
  let service: CommissionPayoutService;
  let earner: Earner;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    earners = await EarnerCollection.create({ db });
    commissions = await CommissionCollection.create({ db });
    adjustments = await CommissionAdjustmentCollection.create({ db });
    payouts = await CommissionPayoutCollection.create({ db });
    service = new CommissionPayoutService({
      earners,
      commissions,
      adjustments,
      payouts,
    });
    earner = await earners.create({
      profileId: 'profile-1',
      displayName: 'Casey Earner',
      status: 'active',
      payoutThresholdCents: 1,
    });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  let counter = 0;
  async function createPayableCommission(
    source: { sourceKind: string; sourceId: string },
    overrides: Record<string, unknown> = {},
  ): Promise<Commission> {
    counter += 1;
    return await commissions.create({
      earnerId: earner.id as string,
      amountCents: 1000,
      currency: 'USD',
      status: 'payable',
      dedupeKey: `hist-comm-${counter}`,
      ...source,
      ...overrides,
    });
  }

  /** Cut one source-scoped batch and return its payout. */
  async function cutSourceBatch(
    source: { sourceKind: string; sourceId: string },
    key: string,
  ): Promise<CommissionPayout> {
    const result = await service.createPayoutBatch({
      earnerId: earner.id as string,
      currency: 'USD',
      ...source,
      idempotencyKey: key,
    });
    expect(result.payout).not.toBeNull();
    return result.payout as CommissionPayout;
  }

  describe('derived single-source stamp', () => {
    it('stamps a source-scoped batch with its source', async () => {
      await createPayableCommission(NETWORK_A);
      await createPayableCommission(NETWORK_A);
      const payout = await cutSourceBatch(NETWORK_A, 'stamp-scoped');
      expect(payout.sourceKind).toBe('ad_network');
      expect(payout.sourceId).toBe('net-a');
    });

    it('derives the stamp for an unscoped batch whose membership happens to be single-source', async () => {
      await createPayableCommission(NETWORK_A);
      const result = await service.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
      });
      expect(result.payout?.sourceKind).toBe('ad_network');
      expect(result.payout?.sourceId).toBe('net-a');
    });

    it('leaves mixed-source and unknown-source batches unstamped', async () => {
      await createPayableCommission(NETWORK_A);
      await createPayableCommission(NETWORK_B);
      const mixed = await service.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'stamp-mixed',
      });
      expect(mixed.payout?.sourceKind).toBe('');
      expect(mixed.payout?.sourceId).toBe('');

      // A commission with no recorded source makes ownership unprovable.
      await createPayableCommission({ sourceKind: '', sourceId: '' });
      const unknown = await service.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        idempotencyKey: 'stamp-unknown',
      });
      expect(unknown.payout?.sourceKind).toBe('');
      expect(unknown.payout?.sourceId).toBe('');
    });
  });

  describe('getSourcePayoutHistory', () => {
    it('validates input and clamps paging', async () => {
      await expect(
        service.getSourcePayoutHistory({ sourceKind: '', sourceId: 'x' }),
      ).rejects.toThrow(/required/);
      const empty = await service.getSourcePayoutHistory({
        ...NETWORK_A,
        limit: 5000,
        offset: -3,
      });
      expect(empty.limit).toBe(100);
      expect(empty.offset).toBe(0);
      expect(empty.payouts).toEqual([]);
      expect(empty.nextOffset).toBeNull();
    });

    it('pages newest-first with a deterministic order and stable offsets', async () => {
      const minted: string[] = [];
      for (let i = 0; i < 5; i++) {
        await createPayableCommission(NETWORK_A);
        const payout = await cutSourceBatch(NETWORK_A, `page-${i}`);
        minted.push(payout.id as string);
      }

      const pageOne = await service.getSourcePayoutHistory({
        ...NETWORK_A,
        limit: 2,
      });
      expect(pageOne.payouts).toHaveLength(2);
      expect(pageOne.excluded).toEqual([]);
      expect(pageOne.nextOffset).toBe(2);

      const pageTwo = await service.getSourcePayoutHistory({
        ...NETWORK_A,
        limit: 2,
        offset: pageOne.nextOffset as number,
      });
      expect(pageTwo.payouts).toHaveLength(2);
      expect(pageTwo.nextOffset).toBe(4);

      const pageThree = await service.getSourcePayoutHistory({
        ...NETWORK_A,
        limit: 2,
        offset: pageTwo.nextOffset as number,
      });
      expect(pageThree.payouts).toHaveLength(1);
      expect(pageThree.nextOffset).toBeNull();

      // Every minted payout appears exactly once across the pages, in the
      // documented (created_at DESC, id DESC) order.
      const seen = [
        ...pageOne.payouts,
        ...pageTwo.payouts,
        ...pageThree.payouts,
      ];
      expect(new Set(seen.map((p) => p.id)).size).toBe(5);
      expect(seen.map((p) => p.id).sort()).toEqual([...minted].sort());
      for (let i = 1; i < seen.length; i++) {
        const prev = seen[i - 1];
        const curr = seen[i];
        const prevKey = `${prev.created_at?.toISOString?.() ?? prev.created_at}`;
        const currKey = `${curr.created_at?.toISOString?.() ?? curr.created_at}`;
        const ordered =
          prevKey > currKey ||
          (prevKey === currKey &&
            String(prev.id ?? '') >= String(curr.id ?? ''));
        expect(ordered).toBe(true);
      }
    });

    it('lists only the requested source and spans payout statuses', async () => {
      await createPayableCommission(NETWORK_A);
      const payoutA = await cutSourceBatch(NETWORK_A, 'span-a');
      await createPayableCommission(NETWORK_B);
      await cutSourceBatch(NETWORK_B, 'span-b');

      // Drive A's payout to completed through the source-authorized door.
      await service.transitionPayoutForSource({
        payoutId: payoutA.id as string,
        ...NETWORK_A,
        action: 'approve',
      });
      await service.transitionPayoutForSource({
        payoutId: payoutA.id as string,
        ...NETWORK_A,
        action: 'mark_processing',
      });
      await service.transitionPayoutForSource({
        payoutId: payoutA.id as string,
        ...NETWORK_A,
        action: 'complete',
        paymentReference: 'wire-1',
      });

      const history = await service.getSourcePayoutHistory(NETWORK_A);
      expect(history.payouts.map((p) => p.id)).toEqual([payoutA.id]);
      expect(history.payouts[0].isCompleted()).toBe(true);
    });

    it('includes adjustment-only payouts, proving ownership through parent commissions', async () => {
      // Batch 1 settles the commission itself.
      const parent = await createPayableCommission(NETWORK_A);
      const first = await cutSourceBatch(NETWORK_A, 'adj-base');

      // A later positive correction arrives for the SAME (now settled)
      // commission — batch 2's membership is the adjustment alone.
      await adjustments.create({
        commissionId: parent.id as string,
        earnerId: earner.id as string,
        adjustmentKind: 'credit',
        amountCents: 250,
        currency: 'USD',
        reason: 'late bonus credit',
      });
      const second = await service.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...NETWORK_A,
        idempotencyKey: 'adj-only',
        minimumThresholdCents: 1,
      });
      expect(second.payout).not.toBeNull();
      expect(second.settledCommissionIds).toEqual([]);
      expect(second.settledAdjustmentIds).toHaveLength(1);
      expect(second.payout?.sourceKind).toBe('ad_network');
      expect(second.payout?.sourceId).toBe('net-a');

      const history = await service.getSourcePayoutHistory(NETWORK_A);
      expect(history.payouts.map((p) => p.id).sort()).toEqual(
        [first.id, second.payout?.id].sort(),
      );
      expect(history.excluded).toEqual([]);
    });

    it('rejects payouts whose membership cannot prove the source (fail closed), advancing offsets without skips', async () => {
      // A legitimate NETWORK_A payout…
      await createPayableCommission(NETWORK_A);
      const good = await cutSourceBatch(NETWORK_A, 'fc-good');

      // …a NETWORK_B payout hand-stamped as NETWORK_A (stamp lies)…
      await createPayableCommission(NETWORK_B);
      const lying = await cutSourceBatch(NETWORK_B, 'fc-lying');
      lying.sourceKind = NETWORK_A.sourceKind;
      lying.sourceId = NETWORK_A.sourceId;
      await lying.save();

      // …and a memberless stamped payout (raced-away batch artifact).
      const memberless = await payouts.create({
        earnerId: earner.id as string,
        currency: 'USD',
        status: 'pending',
        idempotencyKey: 'fc-memberless',
        ...NETWORK_A,
      });

      const history = await service.getSourcePayoutHistory({
        ...NETWORK_A,
        limit: 10,
      });
      expect(history.payouts.map((p) => p.id)).toEqual([good.id]);
      const excludedById = new Map(
        history.excluded.map((e) => [e.payoutId, e.reason]),
      );
      expect(excludedById.get(lying.id as string)).toBe('source_mismatch');
      expect(excludedById.get(memberless.id as string)).toBe(
        'membership_empty',
      );
      // All three stamped rows were scanned; nothing skipped, history done.
      expect(history.nextOffset).toBeNull();
    });

    it('keeps database work bounded by the page for a sparse source under skew', async () => {
      // A busy sibling source with far more history…
      for (let i = 0; i < 40; i++) {
        await createPayableCommission(NETWORK_B);
        await cutSourceBatch(NETWORK_B, `skew-b-${i}`);
      }
      // …and the sparse source under test.
      for (let i = 0; i < 2; i++) {
        await createPayableCommission(NETWORK_A);
        await cutSourceBatch(NETWORK_A, `skew-a-${i}`);
      }

      const originalQuery = db.query.bind(db);
      let queries = 0;
      db.query = (async (sql: string, ...vars: unknown[]) => {
        queries += 1;
        return await originalQuery(sql, ...vars);
      }) as DatabaseInterface['query'];
      try {
        const history = await service.getSourcePayoutHistory({
          ...NETWORK_A,
          limit: 10,
        });
        expect(history.payouts).toHaveLength(2);
        // One stamped-page query + batched membership loads — never a walk
        // of NETWORK_B's 40-payout history and never per-payout queries.
        expect(queries).toBeLessThanOrEqual(4);
      } finally {
        db.query = originalQuery;
      }
    });
  });

  describe('restampPayoutSource backfill', () => {
    it('backfills a pre-stamp payout from its membership and makes it listable', async () => {
      await createPayableCommission(NETWORK_A);
      const payout = await cutSourceBatch(NETWORK_A, 'backfill');
      // Simulate a payout minted before the stamp existed.
      payout.sourceKind = '';
      payout.sourceId = '';
      await payout.save();

      const before = await service.getSourcePayoutHistory(NETWORK_A);
      expect(before.payouts).toEqual([]);

      const restamped = await service.restampPayoutSource(payout.id as string);
      expect(restamped.changed).toBe(true);
      expect(restamped.sourceKind).toBe('ad_network');
      expect(restamped.sourceId).toBe('net-a');

      // Idempotent — a second pass changes nothing.
      const replay = await service.restampPayoutSource(payout.id as string);
      expect(replay.changed).toBe(false);

      const after = await service.getSourcePayoutHistory(NETWORK_A);
      expect(after.payouts.map((p) => p.id)).toEqual([payout.id]);

      const missing = await service.restampPayoutSource(
        '00000000-0000-4000-8000-000000000000',
      );
      expect(missing.payout).toBeNull();
    });
  });
});
