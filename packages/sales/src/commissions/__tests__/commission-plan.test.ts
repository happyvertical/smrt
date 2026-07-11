/**
 * Tests for CommissionPlan versioning, activation immutability, the status
 * transition guard, latestActiveByKey resolution, and createAmendment.
 *
 * Real in-memory SQLite — no mocks of database operations.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommissionPlanCollection } from '../collections/CommissionPlanCollection.js';
import type { CommissionPlanComponent } from '../types.js';

const baseComponents: CommissionPlanComponent[] = [
  {
    key: 'closing',
    trigger: 'invoice_payment',
    basis: 'gross',
    rate: 0.1,
  },
];

describe('CommissionPlan', () => {
  let db: DatabaseInterface;
  let plans: CommissionPlanCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    plans = await CommissionPlanCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  async function createDraft(overrides: Record<string, unknown> = {}) {
    return await plans.create({
      planKey: 'standard-referral',
      version: 1,
      name: 'Standard referral terms',
      currency: 'USD',
      components: JSON.stringify(baseComponents),
      ...overrides,
    });
  }

  it('creates a draft v1 and activates it', async () => {
    const plan = await createDraft();
    expect(plan.status).toBe('draft');
    expect(plan.version).toBe(1);
    expect(plan.getComponents()).toEqual(baseComponents);

    plan.activate();
    await plan.save();
    expect(plan.isActive()).toBe(true);

    const reloaded = await plans.get({ id: plan.id });
    expect(reloaded?.status).toBe('active');
  });

  it('setComponents validates keys, bases, rates, and recurrence', async () => {
    const draft = await createDraft({ planKey: 'validation-plan' });
    expect(() =>
      draft.setComponents([
        { key: 'a', trigger: '*', basis: 'gross', rate: 0.1 },
        { key: 'a', trigger: '*', basis: 'gross', rate: 0.2 },
      ]),
    ).toThrow(/unique/);
    expect(() =>
      draft.setComponents([{ key: 'a', trigger: '*', basis: 'fixed' }]),
    ).toThrow(/fixedAmountCents/);
    expect(() =>
      draft.setComponents([
        { key: 'a', trigger: '*', basis: 'gross', rate: 1.5 },
      ]),
    ).toThrow(/rate in \[0, 1\]/);
    expect(() =>
      draft.setComponents([
        { key: 'a', trigger: '*', basis: 'custom', rate: 0.1 },
      ]),
    ).toThrow(/customBasisKey/);
    expect(() =>
      draft.setComponents([
        {
          key: 'a',
          trigger: '*',
          basis: 'gross',
          rate: 0.1,
          recurrence: { kind: 'recurring', maxOccurrences: 0 },
        },
      ]),
    ).toThrow(/positive integer/);
    // A valid set passes.
    draft.setComponents([
      {
        key: 'a',
        trigger: '*',
        basis: 'fixed',
        fixedAmountCents: 2500,
        recurrence: { kind: 'one_time' },
      },
    ]);
  });

  it('freezes components/currency/planKey/version/effectiveFrom once active', async () => {
    const plan = await createDraft({ planKey: 'frozen-plan' });
    plan.activate();
    await plan.save();

    // Component mutation on an active plan throws at save time.
    plan.setComponents([
      { key: 'closing', trigger: 'invoice_payment', basis: 'gross', rate: 0.2 },
    ]);
    await expect(plan.save()).rejects.toThrow(/immutable once/);

    // A freshly loaded instance is frozen too (snapshot captured on load).
    const loaded = await plans.get({ id: plan.id });
    expect(loaded).toBeTruthy();
    if (!loaded) throw new Error('plan not found');
    loaded.currency = 'EUR';
    await expect(loaded.save()).rejects.toThrow(/immutable once/);

    // Status transitions on the frozen row remain allowed.
    const again = await plans.get({ id: plan.id });
    if (!again) throw new Error('plan not found');
    again.supersede();
    await again.save();
    expect(again.status).toBe('superseded');
  });

  it('rejects illegal status transitions, including raw assignment + save', async () => {
    const plan = await createDraft({ planKey: 'transitions-plan' });

    // Method guards.
    expect(() => plan.supersede()).toThrow(/cannot supersede/);
    plan.activate();
    await plan.save();
    expect(() => plan.activate()).toThrow(/cannot activate/);

    // Raw assignment on a persisted active row: active → draft is illegal.
    plan.status = 'draft';
    await expect(plan.save()).rejects.toThrow(/illegal status transition/);

    // active → retired is a legal edge even via raw assignment.
    const loaded = await plans.get({ id: plan.id });
    if (!loaded) throw new Error('plan not found');
    loaded.status = 'retired';
    await loaded.save();
    expect(loaded.status).toBe('retired');

    // Terminal: retired → anything is rejected.
    loaded.status = 'active';
    await expect(loaded.save()).rejects.toThrow(/illegal status transition/);
  });

  it('createAmendment inserts a version+1 draft copying fields then applying changes', async () => {
    const v1 = await createDraft({
      planKey: 'amend-plan',
      name: 'Original name',
      description: 'Original description',
    });
    v1.activate();
    await v1.save();

    const v2 = await plans.createAmendment('amend-plan', {
      name: 'Amended name',
    });
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('draft');
    expect(v2.planKey).toBe('amend-plan');
    // Changed field applied; untouched fields copied from v1.
    expect(v2.name).toBe('Amended name');
    expect(v2.description).toBe('Original description');
    expect(v2.currency).toBe('USD');
    expect(v2.getComponents()).toEqual(baseComponents);

    // v1 is untouched.
    const v1Reloaded = await plans.get({ id: v1.id });
    expect(v1Reloaded?.status).toBe('active');
    expect(v1Reloaded?.name).toBe('Original name');

    // Amending with components replaces them on the new draft only.
    const newComponents: CommissionPlanComponent[] = [
      { key: 'closing', trigger: '*', basis: 'net', rate: 0.15 },
    ];
    const v3 = await plans.createAmendment('amend-plan', {
      components: newComponents,
    });
    expect(v3.version).toBe(3);
    expect(v3.getComponents()).toEqual(newComponents);

    // Invalid amendment components fail before anything is persisted.
    await expect(
      plans.createAmendment('amend-plan', {
        components: [{ key: 'x', trigger: '*', basis: 'gross', rate: 9 }],
      }),
    ).rejects.toThrow(/rate in \[0, 1\]/);
    expect((await plans.findByPlanKey('amend-plan')).length).toBe(3);

    // Amending a plan that doesn't exist throws.
    await expect(plans.createAmendment('missing-plan')).rejects.toThrow(
      /no versions exist/,
    );
  });

  it('latestActiveByKey picks the highest active version', async () => {
    const v1 = await createDraft({ planKey: 'latest-plan' });
    v1.activate();
    await v1.save();

    const v2 = await plans.createAmendment('latest-plan', {});
    // Draft versions never win.
    let latest = await plans.latestActiveByKey('latest-plan');
    expect(latest?.version).toBe(1);

    v2.activate();
    await v2.save();
    latest = await plans.latestActiveByKey('latest-plan');
    expect(latest?.version).toBe(2);

    // Superseding v2 falls back to the still-active v1.
    v2.supersede();
    await v2.save();
    latest = await plans.latestActiveByKey('latest-plan');
    expect(latest?.version).toBe(1);

    // No active versions → null.
    const v1Again = await plans.get({ id: v1.id });
    if (!v1Again) throw new Error('plan not found');
    v1Again.retire();
    await v1Again.save();
    expect(await plans.latestActiveByKey('latest-plan')).toBeNull();
  });

  it('latestActiveByKey ignores active versions not yet in effect (codex P2)', async () => {
    const now = new Date('2026-07-01T00:00:00Z');
    const v1 = await createDraft({
      planKey: 'effective-plan',
      effectiveFrom: null,
    });
    v1.activate();
    await v1.save();

    // A future-dated amendment activated ahead of its effective date.
    const v2 = await plans.createAmendment('effective-plan', {
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
    });
    v2.activate();
    await v2.save();

    // Before the effective date the in-force version still governs…
    const before = await plans.latestActiveByKey('effective-plan', now);
    expect(before?.version).toBe(1);
    // …and from the effective date on, the amendment takes over.
    const after = await plans.latestActiveByKey(
      'effective-plan',
      new Date('2026-08-01T00:00:00Z'),
    );
    expect(after?.version).toBe(2);
  });

  it('tenants do not collide on the same plan key/version (codex P1)', async () => {
    const a = await createDraft({
      planKey: 'default',
      version: 1,
      tenantId: 'tenant-a',
      name: 'Tenant A terms',
    });
    const b = await createDraft({
      planKey: 'default',
      version: 1,
      tenantId: 'tenant-b',
      name: 'Tenant B terms',
    });
    expect(a.id).not.toBe(b.id);
    expect((await plans.get({ id: a.id }))?.name).toBe('Tenant A terms');
    expect((await plans.get({ id: b.id }))?.name).toBe('Tenant B terms');
  });

  it('scopes latestActiveByKey to a tenant lane with global fallback (codex P1)', async () => {
    const now = new Date('2026-07-01T00:00:00Z');
    const aPlan = await createDraft({
      planKey: 'lane-plan',
      version: 1,
      tenantId: 'tenant-a',
    });
    aPlan.activate();
    await aPlan.save();
    const bPlan = await createDraft({
      planKey: 'lane-plan',
      version: 2,
      tenantId: 'tenant-b',
    });
    bPlan.activate();
    await bPlan.save();

    // Tenant A never resolves tenant B's higher version.
    const forA = await plans.latestActiveByKey('lane-plan', now, 'tenant-a');
    expect(forA?.version).toBe(1);
    expect(forA?.tenantId).toBe('tenant-a');

    // A tenant with no versions of its own falls back to a GLOBAL row only.
    expect(
      await plans.latestActiveByKey('lane-plan', now, 'tenant-c'),
    ).toBeNull();
    const globalPlan = await createDraft({
      planKey: 'lane-plan',
      version: 3,
      tenantId: null,
    });
    globalPlan.activate();
    await globalPlan.save();
    const forC = await plans.latestActiveByKey('lane-plan', now, 'tenant-c');
    expect(forC?.version).toBe(3);
    expect(forC?.tenantId).toBeNull();
  });
});
