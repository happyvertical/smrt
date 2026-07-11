/**
 * Tests for CommissionCalculationService — basis resolution (fixed / gross /
 * net / margin / custom), explicit-net-only semantics, rounding
 * reproducibility and dedupe-key idempotency, split shares, recurrence
 * (one_time / maxOccurrences / windowMonths), currency mismatch, and
 * trigger filtering.
 *
 * Real in-memory SQLite — no mocks of database operations.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import { EarningEventCollection } from '../collections/EarningEventCollection.js';
import type { Earner } from '../models/Earner.js';
import type { EarningEvent } from '../models/EarningEvent.js';
import {
  type CommissionCalculationInput,
  CommissionCalculationService,
} from '../services/CommissionCalculationService.js';
import type { CommissionPlanComponent } from '../types.js';

describe('CommissionCalculationService', () => {
  let db: DatabaseInterface;
  let earners: EarnerCollection;
  let events: EarningEventCollection;
  let commissions: CommissionCollection;
  let service: CommissionCalculationService;
  let earner: Earner;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    earners = await EarnerCollection.create({ db });
    events = await EarningEventCollection.create({ db });
    commissions = await CommissionCollection.create({ db });
    service = new CommissionCalculationService(commissions);
    earner = await earners.create({
      profileId: 'profile-1',
      displayName: 'Casey Rep',
      status: 'active',
    });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  let eventCounter = 0;
  async function createEvent(
    overrides: Record<string, unknown> = {},
  ): Promise<EarningEvent> {
    eventCounter += 1;
    return await events.create({
      eventKind: 'invoice_payment',
      occurredAt: new Date('2026-03-15T12:00:00Z'),
      sourceKind: 'agreement',
      sourceId: 'agr-1',
      grossAmountCents: 10000,
      currency: 'USD',
      dedupeKey: `evt-${eventCounter}`,
      ...overrides,
    });
  }

  function baseInput(
    event: EarningEvent,
    components: CommissionPlanComponent[],
    overrides: Partial<CommissionCalculationInput> = {},
  ): CommissionCalculationInput {
    return {
      event,
      planKey: 'plan-a',
      planVersion: 1,
      components,
      earnerId: earner.id as string,
      ...overrides,
    };
  }

  it('resolves each basis: gross, net, margin, fixed, custom', async () => {
    const event = await createEvent({
      grossAmountCents: 10000,
      netAmountCents: 8000,
      marginCents: 3000,
      customBases: JSON.stringify({ collected: 5000 }),
    });
    const components: CommissionPlanComponent[] = [
      { key: 'on-gross', trigger: '*', basis: 'gross', rate: 0.1 },
      { key: 'on-net', trigger: '*', basis: 'net', rate: 0.1 },
      { key: 'on-margin', trigger: '*', basis: 'margin', rate: 0.5 },
      { key: 'flat', trigger: '*', basis: 'fixed', fixedAmountCents: 2500 },
      {
        key: 'on-custom',
        trigger: '*',
        basis: 'custom',
        rate: 0.2,
        customBasisKey: 'collected',
      },
    ];

    const result = await service.calculateForEvent(
      baseInput(event, components),
    );
    expect(result.skipped).toEqual([]);
    expect(result.existing).toEqual([]);
    const byKey = new Map(result.created.map((c) => [c.componentKey, c]));
    expect(byKey.get('on-gross')?.amountCents).toBe(1000);
    expect(byKey.get('on-net')?.amountCents).toBe(800);
    expect(byKey.get('on-margin')?.amountCents).toBe(1500);
    expect(byKey.get('flat')?.amountCents).toBe(2500);
    expect(byKey.get('flat')?.rate).toBe(0);
    expect(byKey.get('on-custom')?.amountCents).toBe(1000);

    // Every created commission is pending, currency-stamped, source-copied,
    // and carries a complete reproducible trace.
    for (const commission of result.created) {
      expect(commission.status).toBe('pending');
      expect(commission.currency).toBe('USD');
      expect(commission.sourceKind).toBe('agreement');
      expect(commission.sourceId).toBe('agr-1');
      const trace = commission.getCalculationTrace();
      expect(trace).not.toBeNull();
      expect(trace?.roundingMode).toBe('half_away_from_zero');
      expect(trace?.earningEventId).toBe(event.id);
      expect(trace?.planKey).toBe('plan-a');
      expect(trace?.planVersion).toBe(1);
      expect(trace?.occurrenceIndex).toBe(0);
    }
  });

  it('never derives net from gross: null net skips with net_basis_undefined', async () => {
    const event = await createEvent({
      grossAmountCents: 10000,
      netAmountCents: null,
      marginCents: null,
    });
    const result = await service.calculateForEvent(
      baseInput(event, [
        { key: 'on-net', trigger: '*', basis: 'net', rate: 0.1 },
        { key: 'on-margin', trigger: '*', basis: 'margin', rate: 0.1 },
        {
          key: 'on-custom',
          trigger: '*',
          basis: 'custom',
          rate: 0.1,
          customBasisKey: 'missing-key',
        },
      ]),
    );
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([
      { componentKey: 'on-net', reason: 'net_basis_undefined' },
      { componentKey: 'on-margin', reason: 'margin_basis_undefined' },
      { componentKey: 'on-custom', reason: 'custom_basis_missing' },
    ]);
  });

  it('is idempotent: the same input twice returns identical existing rows', async () => {
    const event = await createEvent({ grossAmountCents: 33333 });
    const components: CommissionPlanComponent[] = [
      { key: 'c1', trigger: '*', basis: 'gross', rate: 0.0333 },
    ];

    const first = await service.calculateForEvent(baseInput(event, components));
    expect(first.created).toHaveLength(1);
    // 33333 * 0.0333 = 1109.98… → 1110
    expect(first.created[0].amountCents).toBe(1110);

    const second = await service.calculateForEvent(
      baseInput(event, components),
    );
    expect(second.created).toHaveLength(0);
    expect(second.existing).toHaveLength(1);
    expect(second.existing[0].id).toBe(first.created[0].id);
    expect(second.existing[0].amountCents).toBe(first.created[0].amountCents);
    expect(second.existing[0].dedupeKey).toBe(first.created[0].dedupeKey);

    // Still exactly one row persisted.
    expect(await commissions.findByEvent(event.id as string)).toHaveLength(1);
  });

  it('embeds the terms reference in the dedupe key', async () => {
    const event = await createEvent();
    const components: CommissionPlanComponent[] = [
      { key: 'c1', trigger: '*', basis: 'gross', rate: 0.1 },
    ];

    const viaPlan = await service.calculateForEvent(
      baseInput(event, components),
    );
    expect(viaPlan.created[0].dedupeKey).toBe(
      `${event.dedupeKey}:plan-a@1:c1:${earner.id}:0`,
    );

    const viaSnapshot = await service.calculateForEvent(
      baseInput(event, components, {
        termsSnapshotKind: 'referral_term_snapshot',
        termsSnapshotId: 'snap-9',
      }),
    );
    expect(viaSnapshot.created[0].dedupeKey).toBe(
      `${event.dedupeKey}:snap-9:c1:${earner.id}:0`,
    );
    expect(viaSnapshot.created[0].termsSnapshotKind).toBe(
      'referral_term_snapshot',
    );
    expect(viaSnapshot.created[0].termsSnapshotId).toBe('snap-9');
  });

  it('splits across earners with deterministic per-share rounding', async () => {
    const other = await earners.create({
      profileId: 'profile-2',
      displayName: 'Riley Rep',
      status: 'active',
    });
    // 125 * 0.1 = 12.5 → unsplit would be 13; shares round independently.
    const event = await createEvent({ grossAmountCents: 125 });
    const components: CommissionPlanComponent[] = [
      { key: 'c1', trigger: '*', basis: 'gross', rate: 0.1 },
    ];

    const a = await service.calculateForEvent(
      baseInput(event, components, {
        shareFraction: 0.6,
        splitGroupId: 'split-1',
      }),
    );
    const b = await service.calculateForEvent(
      baseInput(event, components, {
        earnerId: other.id as string,
        shareFraction: 0.4,
        splitGroupId: 'split-1',
      }),
    );

    // 12.5 * 0.6 = 7.5 → 8 (half away from zero); 12.5 * 0.4 = 5 → 5.
    expect(a.created[0].amountCents).toBe(8);
    expect(b.created[0].amountCents).toBe(5);
    expect(a.created[0].splitGroupId).toBe('split-1');
    expect(b.created[0].splitGroupId).toBe('split-1');
    expect(a.created[0].shareFraction).toBeCloseTo(0.6);
    expect(b.created[0].shareFraction).toBeCloseTo(0.4);
    // Siblings sum to the full (rounded) commission.
    expect(a.created[0].amountCents + b.created[0].amountCents).toBe(13);

    // A clean 0.6/0.4 split of an even base sums exactly.
    const even = await createEvent({ grossAmountCents: 10000 });
    const ea = await service.calculateForEvent(
      baseInput(even, components, { shareFraction: 0.6 }),
    );
    const eb = await service.calculateForEvent(
      baseInput(even, components, {
        earnerId: other.id as string,
        shareFraction: 0.4,
      }),
    );
    expect(ea.created[0].amountCents + eb.created[0].amountCents).toBe(1000);
  });

  it('enforces one_time recurrence via the occurrence resolver', async () => {
    const components: CommissionPlanComponent[] = [
      {
        key: 'signup-bonus',
        trigger: '*',
        basis: 'fixed',
        fixedAmountCents: 5000,
        recurrence: { kind: 'one_time' },
      },
    ];
    const resolver = async (componentKey: string) =>
      (
        await commissions.list({
          where: {
            earnerId: earner.id,
            componentKey,
            planKey: 'plan-a',
          },
        })
      ).length;

    const firstEvent = await createEvent();
    const first = await service.calculateForEvent(
      baseInput(firstEvent, components, {
        occurrenceCountResolver: resolver,
      }),
    );
    expect(first.created).toHaveLength(1);
    expect(first.created[0].getCalculationTrace()?.occurrenceIndex).toBe(0);

    // A SECOND event: the bonus already fired once → skipped.
    const second = await service.calculateForEvent(
      baseInput(await createEvent(), components, {
        occurrenceCountResolver: resolver,
      }),
    );
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toEqual([
      { componentKey: 'signup-bonus', reason: 'occurrence_limit_reached' },
    ]);

    // Replaying the FIRST event stays idempotent (existing, not skipped) —
    // even though the resolver now reports one consumed occurrence.
    const replay = await service.calculateForEvent(
      baseInput(firstEvent, components, {
        occurrenceCountResolver: resolver,
      }),
    );
    expect(replay.created).toHaveLength(0);
    expect(replay.existing).toHaveLength(1);
    expect(replay.existing[0].id).toBe(first.created[0].id);
  });

  it('enforces recurring maxOccurrences', async () => {
    const components: CommissionPlanComponent[] = [
      {
        key: 'residual',
        trigger: '*',
        basis: 'gross',
        rate: 0.05,
        recurrence: { kind: 'recurring', maxOccurrences: 2 },
      },
    ];
    const resolver = async (componentKey: string) =>
      (
        await commissions.list({
          where: { earnerId: earner.id, componentKey, planKey: 'plan-a' },
        })
      ).length;

    const r1 = await service.calculateForEvent(
      baseInput(await createEvent(), components, {
        occurrenceCountResolver: resolver,
      }),
    );
    const r2 = await service.calculateForEvent(
      baseInput(await createEvent(), components, {
        occurrenceCountResolver: resolver,
      }),
    );
    const r3 = await service.calculateForEvent(
      baseInput(await createEvent(), components, {
        occurrenceCountResolver: resolver,
      }),
    );
    expect(r1.created).toHaveLength(1);
    expect(r2.created).toHaveLength(1);
    expect(r2.created[0].getCalculationTrace()?.occurrenceIndex).toBe(1);
    expect(r3.created).toHaveLength(0);
    expect(r3.skipped).toEqual([
      { componentKey: 'residual', reason: 'occurrence_limit_reached' },
    ]);
  });

  it('enforces windowMonths against the anchor date', async () => {
    const components: CommissionPlanComponent[] = [
      {
        key: 'windowed',
        trigger: '*',
        basis: 'gross',
        rate: 0.05,
        recurrence: { kind: 'recurring', windowMonths: 3 },
      },
    ];
    const anchorAt = new Date('2026-01-01T00:00:00Z');

    const inside = await service.calculateForEvent(
      baseInput(
        await createEvent({ occurredAt: new Date('2026-02-15T00:00:00Z') }),
        components,
        { anchorAt },
      ),
    );
    expect(inside.created).toHaveLength(1);

    const outside = await service.calculateForEvent(
      baseInput(
        await createEvent({ occurredAt: new Date('2026-05-02T00:00:00Z') }),
        components,
        { anchorAt },
      ),
    );
    expect(outside.created).toHaveLength(0);
    expect(outside.skipped).toEqual([
      { componentKey: 'windowed', reason: 'outside_recurrence_window' },
    ]);
  });

  it('skips every matching component on a plan/event currency mismatch', async () => {
    const event = await createEvent({ currency: 'USD' });
    const result = await service.calculateForEvent(
      baseInput(
        event,
        [
          { key: 'a', trigger: '*', basis: 'gross', rate: 0.1 },
          { key: 'b', trigger: '*', basis: 'fixed', fixedAmountCents: 100 },
        ],
        { currency: 'EUR' },
      ),
    );
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([
      { componentKey: 'a', reason: 'currency_mismatch' },
      { componentKey: 'b', reason: 'currency_mismatch' },
    ]);
  });

  it("filters components by trigger: '*' and exact kind fire, others are silently ignored", async () => {
    const event = await createEvent({ eventKind: 'conversion' });
    const result = await service.calculateForEvent(
      baseInput(event, [
        {
          key: 'on-conversion',
          trigger: 'conversion',
          basis: 'gross',
          rate: 0.1,
        },
        { key: 'on-anything', trigger: '*', basis: 'gross', rate: 0.05 },
        {
          key: 'on-invoice',
          trigger: 'invoice_payment',
          basis: 'gross',
          rate: 0.2,
        },
      ]),
    );
    expect(result.created.map((c) => c.componentKey).sort()).toEqual([
      'on-anything',
      'on-conversion',
    ]);
    // Non-matching triggers are filtered, not "skipped" noise.
    expect(result.skipped).toEqual([]);
  });

  it('stamps clearingEndsAt from clearingDays and inherits the event tenant', async () => {
    const event = await createEvent({
      occurredAt: new Date('2026-03-01T00:00:00Z'),
      tenantId: 'tenant-x',
    });
    const result = await service.calculateForEvent(
      baseInput(
        event,
        [{ key: 'c1', trigger: '*', basis: 'gross', rate: 0.1 }],
        { clearingDays: 30 },
      ),
    );
    const commission = result.created[0];
    expect(commission.clearingEndsAt?.toISOString()).toBe(
      '2026-03-31T00:00:00.000Z',
    );
    expect(commission.tenantId).toBe('tenant-x');
  });

  it('rejects a shareFraction outside [0, 1] or non-finite (codex P2)', async () => {
    const event = await createEvent({ grossAmountCents: 10000 });
    const components: CommissionPlanComponent[] = [
      { key: 'guard', trigger: '*', basis: 'gross', rate: 0.1 },
    ];
    for (const bad of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        service.calculateForEvent(
          baseInput(event, components, { shareFraction: bad }),
        ),
      ).rejects.toThrow(/shareFraction must be a finite number in \[0, 1\]/);
    }
    // Boundary values are legal: 0 produces a zero-amount commission.
    const zero = await service.calculateForEvent(
      baseInput(event, components, { shareFraction: 0 }),
    );
    expect(zero.created).toHaveLength(1);
    expect(zero.created[0]?.amountCents).toBe(0);
  });

  it('earning events are immutable evidence (codex P2)', async () => {
    const event = await createEvent({
      grossAmountCents: 10000,
      dedupeKey: 'immutable-evt-1',
    });

    // Hydrated edit → rejected.
    const hydrated = await events.get({ id: event.id });
    if (!hydrated) throw new Error('missing event');
    hydrated.grossAmountCents = 99999;
    await expect(hydrated.save()).rejects.toThrow(/immutable\s+evidence/);

    // Same dedupeKey with DIFFERENT values → rejected (would upsert over
    // the evidence row via the natural key).
    await expect(
      events.create({
        eventKind: 'invoice_payment',
        occurredAt: new Date('2026-03-15T12:00:00Z'),
        sourceKind: 'agreement',
        sourceId: 'agr-1',
        grossAmountCents: 55555,
        currency: 'USD',
        dedupeKey: 'immutable-evt-1',
      }),
    ).rejects.toThrow(/immutable evidence/);

    // Even an IDENTICAL raw retried create is refused: the natural-key
    // upsert would rotate the row's id and orphan commissions referencing
    // it. Idempotent ingestion goes through getOrCreateByDedupeKey.
    await expect(
      events.create({
        eventKind: 'invoice_payment',
        occurredAt: new Date('2026-03-15T12:00:00Z'),
        sourceKind: 'agreement',
        sourceId: 'agr-1',
        grossAmountCents: 10000,
        currency: 'USD',
        dedupeKey: 'immutable-evt-1',
      }),
    ).rejects.toThrow(/immutable evidence/);

    const replay = await events.getOrCreateByDedupeKey({
      eventKind: 'invoice_payment',
      occurredAt: new Date('2026-03-15T12:00:00Z'),
      sourceKind: 'agreement',
      sourceId: 'agr-1',
      grossAmountCents: 10000,
      currency: 'USD',
      dedupeKey: 'immutable-evt-1',
    });
    expect(replay.created).toBe(false);
    expect(replay.event.id).toBe(event.id);
    const rows = await events.list({
      where: { dedupeKey: 'immutable-evt-1' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(event.id);
    expect(rows[0]?.grossAmountCents).toBe(10000);
  });

  it('rejects malformed components before any money math (codex P2)', async () => {
    const event = await createEvent();
    await expect(
      service.calculateForEvent(
        baseInput(event, [
          { key: 'bad-rate', trigger: '*', basis: 'gross', rate: 2 },
        ]),
      ),
    ).rejects.toThrow(/rate/);
    await expect(
      service.calculateForEvent(
        baseInput(event, [
          {
            key: 'bad-fixed',
            trigger: '*',
            basis: 'fixed',
            fixedAmountCents: 12.5,
          },
        ]),
      ),
    ).rejects.toThrow(/fixedAmountCents/);
  });
});
