/** Payout routing snapshots (#4148); real database persistence, no transfers. */
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { CommissionPayoutCollection } from '../collections/CommissionPayoutCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import { CommissionPayoutService } from '../services/CommissionPayoutService.js';
import type { PayoutDestination } from '../types.js';

const destinations: PayoutDestination[] = [
  { method: 'stripe_connect', connectedAccountId: 'acct_original' },
  {
    method: 'crypto',
    network: 'bitcoin',
    asset: 'BTC',
    address: 'bc1qoriginal',
    memo: 'member',
  },
];

for (const type of ['sqlite', 'duckdb', 'postgres'] as const) {
  describe.skipIf(type === 'postgres' && !process.env.SMRT_TEST_POSTGRES_URL)(
    `Payout destinations on ${type}`,
    () => {
      let db: DatabaseInterface;
      let isolated: IsolatedTestDbResult | undefined;
      let earners: EarnerCollection;
      let commissions: CommissionCollection;
      let payouts: CommissionPayoutCollection;
      let service: CommissionPayoutService;
      beforeEach(async () => {
        if (type === 'postgres') {
          isolated = await createIsolatedTestDbFromManifest({
            includeObjects: [
              'Earner',
              'EarningEvent',
              'Commission',
              'CommissionAdjustment',
              'CommissionPayout',
            ],
          });
          db = isolated.baseDb;
        } else {
          db = await getTestDatabase({
            type,
            url: ':memory:',
            classes: [
              'Earner',
              'EarningEvent',
              'Commission',
              'CommissionAdjustment',
              'CommissionPayout',
            ],
            // DuckDB cannot enforce ON UPDATE CASCADE. This routing test does
            // not exercise foreign-key enforcement; PostgreSQL/SQLite do.
            omitForeignKeyConstraints: type === 'duckdb',
          });
        }
        earners = await EarnerCollection.create({ db });
        commissions = await CommissionCollection.create({ db });
        payouts = await CommissionPayoutCollection.create({ db });
        service = new CommissionPayoutService({
          earners,
          commissions,
          payouts,
          adjustments: await CommissionAdjustmentCollection.create({ db }),
        });
      });
      afterEach(async () => {
        if (isolated) {
          await isolated.cleanup();
          isolated = undefined;
        } else await db?.close?.();
      });

      async function batch(destination: PayoutDestination, key: string) {
        const earner = await earners.create({ payoutThresholdCents: 0 });
        earner.setPayoutDestination(destination);
        await earner.save();
        await commissions.create({
          earnerId: earner.id!,
          status: 'payable',
          amountCents: 500,
          currency: 'USD',
          sourceKind: 'network',
          sourceId: key,
          dedupeKey: `${key}-commission`,
        });
        const request = {
          earnerId: earner.id!,
          currency: 'USD',
          idempotencyKey: key,
        };
        const result = await service.createPayoutBatch(request);
        return { earner, request, payout: result.payout! };
      }

      for (const destination of destinations) {
        it(`freezes ${destination.method} at creation and preserves it across earner edits/replay and failed reset`, async () => {
          const { earner, request, payout } = await batch(
            destination,
            `snapshot-${destination.method}`,
          );
          expect(JSON.parse(payout.payoutDestination)).toEqual(destination);
          earner.setPayoutDestination({
            method: 'stripe_connect',
            connectedAccountId: 'acct_changed',
          });
          await earner.save();
          const replay = await service.createPayoutBatch(request);
          expect(replay.created).toBe(false);
          expect(replay.payout?.getPayoutDestination()).toEqual(destination);
          payout.approve();
          await payout.save();
          payout.markProcessing();
          await payout.save();
          payout.fail('operator retry');
          await payout.save();
          payout.resetFromFailed();
          await payout.save();
          const reloaded = await payouts.get({ id: payout.id! });
          expect(reloaded?.getPayoutDestination()).toEqual(destination);
          reloaded!.setPayoutDestination({
            method: 'stripe_connect',
            connectedAccountId: 'acct_redirect',
          });
          await expect(reloaded!.save()).rejects.toThrow(/routing.*immutable/i);
        });
      }

      it('repairs interrupted membership totals without refreshing routing', async () => {
        const { earner, request, payout } = await batch(
          destinations[0],
          'repair-routing',
        );
        await db.query(
          'UPDATE commission_payouts SET commission_total_cents = 1, total_amount_cents = 1 WHERE id = ?',
          payout.id,
        );
        earner.setPayoutDestination(destinations[1]);
        await earner.save();
        const repaired = await service.createPayoutBatch(request);
        expect(repaired.created).toBe(false);
        expect(repaired.payout?.totalAmountCents).toBe(500);
        expect(repaired.payout?.getPayoutDestination()).toEqual(
          destinations[0],
        );
      });

      it('rejects and recreates a batch to adopt another destination', async () => {
        const { earner, request, payout } = await batch(
          destinations[0],
          'replace-routing',
        );
        earner.setPayoutDestination(destinations[1]);
        await earner.save();
        const rejected = await service.transitionPayoutForSource({
          payoutId: payout.id!,
          sourceKind: 'network',
          sourceId: 'replace-routing',
          action: 'reject',
          reason: 'Change destination before payment',
        });
        expect(rejected.outcome).toBe('transitioned');
        const replacement = await service.createPayoutBatch({
          ...request,
          idempotencyKey: 'replacement-routing',
        });
        expect(replacement.created).toBe(true);
        expect(replacement.payout?.getPayoutDestination()).toEqual(
          destinations[1],
        );
        expect(
          (await payouts.get({ id: payout.id! }))?.getPayoutDestination(),
        ).toEqual(destinations[0]);
      });

      it('rolls back a source-authorized approval with missing legacy routing', async () => {
        const { payout } = await batch(destinations[0], 'legacy-approval');
        await db.query(
          "UPDATE commission_payouts SET payout_destination = '{}' WHERE id = ?",
          payout.id,
        );
        await expect(
          service.transitionPayoutForSource({
            payoutId: payout.id!,
            sourceKind: 'network',
            sourceId: 'legacy-approval',
            action: 'approve',
          }),
        ).rejects.toThrow(/requires.*payoutDestination/);
        expect((await payouts.get({ id: payout.id! }))?.status).toBe('pending');
        const members = await commissions.list({
          where: { payoutId: payout.id! },
        });
        expect(members).toHaveLength(1);
        expect(members[0].status).toBe('payable');
      });

      it('refuses pending routing edits, method changes, blind-id and natural-key overwrites', async () => {
        const { payout } = await batch(destinations[0], 'overwrite');
        payout.payoutMethod = 'paypal';
        payout.payoutDestination = '{}';
        await expect(payout.save()).rejects.toThrow(/routing.*immutable/i);
        for (const identity of [{ id: payout.id!, _skipLoad: true }, {}]) {
          await expect(
            payouts.create({
              ...identity,
              earnerId: payout.earnerId,
              idempotencyKey: payout.idempotencyKey,
              payoutMethod: 'stripe_connect',
              payoutDestination: JSON.stringify({
                method: 'stripe_connect',
                connectedAccountId: 'acct_redirect',
              }),
            }),
          ).rejects.toThrow(/routing.*immutable/i);
        }
        expect(
          (await payouts.get({ id: payout.id! }))?.getPayoutDestination(),
        ).toEqual(destinations[0]);
      });

      it('refuses malformed, mismatched and secret-bearing routing descriptors before persistence', async () => {
        const earner = await earners.create({});
        for (const payoutDestination of [
          'bad json',
          '[]',
          '{"method":"unknown"}',
          '{"method":"stripe_connect","connectedAccountId":"acct_original","secret":"no"}',
          JSON.stringify(destinations[1]),
        ]) {
          await expect(
            payouts.create({
              earnerId: earner.id!,
              idempotencyKey: `bad-${payoutDestination}`,
              payoutMethod: 'stripe_connect',
              payoutDestination,
            }),
          ).rejects.toThrow(/payoutDestination/);
        }
      });

      it('refuses a legacy typed batch without snapshot at approval; manual legacy batches still approve', async () => {
        const earner = await earners.create({});
        const payout = await payouts.create({
          earnerId: earner.id!,
          idempotencyKey: 'legacy-typed',
          payoutMethod: 'stripe_connect',
          commissionTotalCents: 100,
          totalAmountCents: 100,
        });
        expect(payout.getPayoutDestination()).toBeNull();
        expect(() => payout.approve()).toThrow(/requires.*payoutDestination/);
        payout.status = 'approved';
        await expect(payout.save()).rejects.toThrow(
          /requires.*payoutDestination/,
        );
        expect((await payouts.get({ id: payout.id! }))?.status).toBe('pending');
        const manual = await payouts.create({
          earnerId: earner.id!,
          idempotencyKey: 'legacy-manual',
          commissionTotalCents: 100,
          totalAmountCents: 100,
        });
        manual.approve();
        await manual.save();
        expect(manual.status).toBe('approved');
      });
    },
  );
}
