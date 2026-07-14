/**
 * PostgreSQL coverage for the three source-scoped capabilities:
 *
 * - #1986 EarnerSourceAttribution — indexed lookups, natural-key upsert, and
 *   the PG-specific NULL-tenant duplicate gap (unique indexes treat NULLs as
 *   distinct, so duplicate GLOBAL mappings are representable → resolution
 *   must fail closed).
 * - #1985 source-scoped payout history — stamping and verified pagination on
 *   native-uuid columns.
 * - #1987 transactional lifecycle transitions — the real `SELECT … FOR
 *   UPDATE` path with genuinely concurrent pooled transactions, terminal
 *   metadata preservation, and reject's membership release (empty-FK → NULL
 *   coercion on uuid columns).
 *
 * The suite uses the harness's BASE connection (not the per-test rollback
 * transaction) because the service under test manages its own transactions;
 * every test namespaces its rows with unique keys instead.
 */

import { randomUUID } from 'node:crypto';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { CommissionPayoutCollection } from '../collections/CommissionPayoutCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import { EarnerSourceAttributionCollection } from '../collections/EarnerSourceAttributionCollection.js';
import type { Commission } from '../models/Commission.js';
import type { CommissionPayout } from '../models/CommissionPayout.js';
import type { Earner } from '../models/Earner.js';
import { CommissionPayoutService } from '../services/CommissionPayoutService.js';
import { EarnerAttributionService } from '../services/EarnerAttributionService.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('Source-scoped commissions APIs on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let earners: EarnerCollection;
  let attributions: EarnerSourceAttributionCollection;
  let commissions: CommissionCollection;
  let adjustments: CommissionAdjustmentCollection;
  let payouts: CommissionPayoutCollection;
  let attributionService: EarnerAttributionService;
  let payoutService: CommissionPayoutService;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Earner',
        'EarnerSourceAttribution',
        'EarningEvent',
        'Commission',
        'CommissionAdjustment',
        'CommissionPayout',
      ],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database.');
    }
    // The service manages its own transactions, so bind everything to the
    // BASE connection; unique per-test keys provide the isolation.
    db = isolated.baseDb;
    earners = await EarnerCollection.create({ db });
    attributions = await EarnerSourceAttributionCollection.create({ db });
    commissions = await CommissionCollection.create({ db });
    adjustments = await CommissionAdjustmentCollection.create({ db });
    payouts = await CommissionPayoutCollection.create({ db });
    attributionService = new EarnerAttributionService({
      earners,
      attributions,
    });
    payoutService = new CommissionPayoutService({
      earners,
      commissions,
      adjustments,
      payouts,
    });
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  async function createActiveEarner(): Promise<Earner> {
    return await earners.create({
      // Cross-package refs are native uuid columns on PostgreSQL.
      profileId: randomUUID(),
      displayName: 'PG earner',
      status: 'active',
      payoutThresholdCents: 1,
    });
  }

  async function createPayableCommission(
    earner: Earner,
    source: { sourceKind: string; sourceId: string },
    overrides: Record<string, unknown> = {},
  ): Promise<Commission> {
    return await commissions.create({
      earnerId: earner.id as string,
      amountCents: 1000,
      currency: 'USD',
      status: 'payable',
      dedupeKey: `pg-comm-${randomUUID()}`,
      ...source,
      ...overrides,
    });
  }

  describe('#1986 earner source attribution', () => {
    it('registers, resolves single + batched, and stays bounded to the requested ids', async () => {
      const kind = `pg_kind_${randomUUID().slice(0, 8)}`;
      const alpha = await createActiveEarner();
      const beta = await createActiveEarner();
      await attributionService.registerAttribution({
        earnerId: alpha.id as string,
        sourceKind: kind,
        sourceId: 'prop-a',
      });
      await attributionService.registerAttribution({
        earnerId: beta.id as string,
        sourceKind: kind,
        sourceId: 'prop-b',
      });

      const single = await attributionService.resolveActiveEarnerBySource({
        sourceKind: kind,
        sourceId: 'prop-a',
      });
      expect(single.earner?.id).toBe(alpha.id);

      const batched = await attributionService.resolveActiveEarnersBySources({
        sourceKind: kind,
        sourceIds: ['prop-a', 'prop-b', 'prop-missing'],
      });
      expect(batched.earnersBySourceId.get('prop-a')?.id).toBe(alpha.id);
      expect(batched.earnersBySourceId.get('prop-b')?.id).toBe(beta.id);
      expect(batched.unresolved).toEqual([
        { sourceId: 'prop-missing', reason: 'no_mapping' },
      ]);
    });

    it('NULL-tenant registrations dedup through the null-aware upsert; true duplicates still fail closed', async () => {
      const kind = `pg_kind_${randomUUID().slice(0, 8)}`;
      const first = await createActiveEarner();
      const second = await createActiveEarner();

      // The natural key is (tenant_id, source_kind, source_id). Although
      // PostgreSQL unique indexes treat NULLs as distinct, the adapter's
      // null-aware upsert dedups NULL-tenant creates too — the second
      // create re-points the one row instead of inserting a sibling.
      await attributions.create({
        earnerId: first.id as string,
        sourceKind: kind,
        sourceId: 'prop-dup',
      });
      await attributions.create({
        earnerId: second.id as string,
        sourceKind: kind,
        sourceId: 'prop-dup',
      });
      const deduped = await attributions.findBySource(kind, 'prop-dup');
      expect(deduped).toHaveLength(1);
      expect(deduped[0].earnerId).toBe(second.id);

      // A TRUE duplicate can still arrive outside the model layer (raw-SQL
      // imports, pre-null-aware data) because the index itself does not
      // dedup NULLs — resolution must fail closed, never guess.
      await db.query(
        `INSERT INTO earner_source_attributions (
          id, slug, context, tenant_id, earner_id, source_kind, source_id,
          status, metadata
        ) VALUES ($1, $2, '', NULL, $3, $4, $5, 'active', '{}')`,
        randomUUID(),
        `import-dup-${randomUUID().slice(0, 8)}`,
        first.id,
        kind,
        'prop-dup',
      );
      const rows = await attributions.findBySource(kind, 'prop-dup');
      expect(rows).toHaveLength(2);

      const resolved = await attributionService.resolveActiveEarnerBySource({
        sourceKind: kind,
        sourceId: 'prop-dup',
      });
      expect(resolved.earner).toBeNull();
      expect(resolved.reason).toBe('ambiguous_mapping');

      await expect(
        attributionService.registerAttribution({
          earnerId: first.id as string,
          sourceKind: kind,
          sourceId: 'prop-dup',
        }),
      ).rejects.toThrow(/holds 2 mappings/);
    });
  });

  describe('#1985 source-scoped payout history', () => {
    it('stamps scoped batches and pages the verified history newest-first', async () => {
      const netA = {
        sourceKind: 'ad_network',
        sourceId: `net-${randomUUID()}`,
      };
      const netB = {
        sourceKind: 'ad_network',
        sourceId: `net-${randomUUID()}`,
      };
      const earner = await createActiveEarner();

      const minted: string[] = [];
      for (let i = 0; i < 3; i++) {
        await createPayableCommission(earner, netA);
        const batch = await payoutService.createPayoutBatch({
          earnerId: earner.id as string,
          currency: 'USD',
          ...netA,
          idempotencyKey: `pg-hist-a-${i}-${netA.sourceId}`,
        });
        minted.push(batch.payout?.id as string);
        expect(batch.payout?.sourceKind).toBe(netA.sourceKind);
        expect(batch.payout?.sourceId).toBe(netA.sourceId);
      }
      // Noise from a sibling source never enters A's history.
      await createPayableCommission(earner, netB);
      await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...netB,
        idempotencyKey: `pg-hist-b-${netB.sourceId}`,
      });

      const pageOne = await payoutService.getSourcePayoutHistory({
        ...netA,
        limit: 2,
      });
      expect(pageOne.payouts).toHaveLength(2);
      expect(pageOne.excluded).toEqual([]);
      expect(pageOne.nextOffset).toBe(2);
      const pageTwo = await payoutService.getSourcePayoutHistory({
        ...netA,
        limit: 2,
        offset: 2,
      });
      expect(pageTwo.payouts).toHaveLength(1);
      expect(pageTwo.nextOffset).toBeNull();
      const seen = [...pageOne.payouts, ...pageTwo.payouts].map((p) => p.id);
      expect([...seen].sort()).toEqual([...minted].sort());
    });

    it('includes adjustment-only payouts and excludes unprovable rows fail-closed', async () => {
      const net = { sourceKind: 'ad_network', sourceId: `net-${randomUUID()}` };
      const earner = await createActiveEarner();
      const parent = await createPayableCommission(earner, net);
      await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...net,
        idempotencyKey: `pg-adj-base-${net.sourceId}`,
      });
      await adjustments.create({
        commissionId: parent.id as string,
        earnerId: earner.id as string,
        adjustmentKind: 'credit',
        amountCents: 300,
        currency: 'USD',
        reason: 'pg late credit',
      });
      const adjOnly = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...net,
        idempotencyKey: `pg-adj-only-${net.sourceId}`,
      });
      expect(adjOnly.settledCommissionIds).toEqual([]);
      expect(adjOnly.settledAdjustmentIds).toHaveLength(1);

      // A memberless stamped artifact must be excluded, not listed.
      const artifact = await payouts.create({
        earnerId: earner.id as string,
        currency: 'USD',
        status: 'pending',
        idempotencyKey: `pg-artifact-${net.sourceId}`,
        ...net,
      });

      const history = await payoutService.getSourcePayoutHistory({
        ...net,
        limit: 10,
      });
      expect(history.payouts).toHaveLength(2);
      expect(history.excluded).toEqual([
        {
          payoutId: artifact.id,
          reason: 'membership_empty',
          detail: expect.stringMatching(/stamped/),
        },
      ]);
    });
  });

  describe('#1987 transactional lifecycle transitions', () => {
    it('serializes genuinely concurrent transitions on the row lock (exactly one wins)', async () => {
      const net = { sourceKind: 'ad_network', sourceId: `net-${randomUUID()}` };
      const earner = await createActiveEarner();
      await createPayableCommission(earner, net);
      const batch = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...net,
        idempotencyKey: `pg-conc-${net.sourceId}`,
      });
      const payout = batch.payout as CommissionPayout;

      // Pooled connections make these truly concurrent; the FOR UPDATE
      // row lock must serialize them into one transition + echoes.
      const outcomes = await Promise.all(
        [0, 1, 2].map(() =>
          payoutService.transitionPayoutForSource({
            payoutId: payout.id as string,
            ...net,
            action: 'approve',
          }),
        ),
      );
      const kinds = outcomes.map((o) => o.outcome);
      expect(kinds.filter((k) => k === 'transitioned')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'already_applied')).toHaveLength(2);

      const settled = await payouts.get({ id: payout.id as string });
      expect(settled?.isApproved()).toBe(true);
    });

    it('completes atomically, is terminally idempotent, and never rewrites payment metadata', async () => {
      const net = { sourceKind: 'ad_network', sourceId: `net-${randomUUID()}` };
      const earner = await createActiveEarner();
      const member = await createPayableCommission(earner, net);
      const batch = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...net,
        idempotencyKey: `pg-complete-${net.sourceId}`,
      });
      const payout = batch.payout as CommissionPayout;
      for (const action of ['approve', 'mark_processing'] as const) {
        const step = await payoutService.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...net,
          action,
        });
        expect(step.outcome).toBe('transitioned');
      }

      const [first, second] = await Promise.all([
        payoutService.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...net,
          action: 'complete',
          paymentReference: 'pg-wire-first',
        }),
        payoutService.transitionPayoutForSource({
          payoutId: payout.id as string,
          ...net,
          action: 'complete',
          paymentReference: 'pg-wire-second',
        }),
      ]);
      expect([first.outcome, second.outcome].sort()).toEqual([
        'already_applied',
        'transitioned',
      ]);
      const winnerRef =
        first.outcome === 'transitioned' ? 'pg-wire-first' : 'pg-wire-second';
      const settled = await payouts.get({ id: payout.id as string });
      expect(settled?.paymentReference).toBe(winnerRef);
      const paidMember = await commissions.get({ id: member.id as string });
      expect(paidMember?.isPaid()).toBe(true);

      // A later replay with different metadata changes nothing.
      const replay = await payoutService.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...net,
        action: 'complete',
        paymentReference: 'pg-wire-late',
      });
      expect(replay.outcome).toBe('already_applied');
      expect(replay.payout?.paymentReference).toBe(winnerRef);
    });

    it('rejects with membership release on native-uuid columns (empty FK → NULL)', async () => {
      const net = { sourceKind: 'ad_network', sourceId: `net-${randomUUID()}` };
      const earner = await createActiveEarner();
      const member = await createPayableCommission(earner, net);
      const batch = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...net,
        idempotencyKey: `pg-reject-${net.sourceId}`,
      });
      const payout = batch.payout as CommissionPayout;

      const rejected = await payoutService.transitionPayoutForSource({
        payoutId: payout.id as string,
        ...net,
        action: 'reject',
        reason: 'pg operator declined',
      });
      expect(rejected.outcome).toBe('transitioned');
      expect(rejected.releasedCommissionIds).toEqual([member.id]);

      // The released FK persists as NULL on the uuid column and the row is
      // gatherable again.
      const released = await commissions.get({ id: member.id as string });
      expect(released?.payoutId ?? '').toBe('');
      const regathered = await commissions.findPayableUnsettled(
        earner.id as string,
        'USD',
        net,
      );
      expect(regathered.map((c) => c.id)).toEqual([member.id]);
    });

    it('refuses the wrong source under the lock', async () => {
      const net = { sourceKind: 'ad_network', sourceId: `net-${randomUUID()}` };
      const other = {
        sourceKind: 'ad_network',
        sourceId: `net-${randomUUID()}`,
      };
      const earner = await createActiveEarner();
      await createPayableCommission(earner, net);
      const batch = await payoutService.createPayoutBatch({
        earnerId: earner.id as string,
        currency: 'USD',
        ...net,
        idempotencyKey: `pg-wrong-${net.sourceId}`,
      });

      const refused = await payoutService.transitionPayoutForSource({
        payoutId: batch.payout?.id as string,
        ...other,
        action: 'approve',
      });
      expect(refused.outcome).toBe('refused');
      expect(refused.refusal?.reason).toBe('source_mismatch');
    });
  });
});
