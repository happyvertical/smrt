/** Shared SQLite/PostgreSQL history and tenant-lane regression contracts. */
import { randomUUID } from 'node:crypto';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { expect, it, vi } from 'vitest';
import type { AgreementCollection } from '../collections/AgreementCollection.js';
import { Agreement } from '../models/Agreement.js';

export function agreementHistoryCases(
  collection: () => AgreementCollection,
): void {
  const kind = 'history_contract';
  const partyA = { kind: 'organization', id: 'coop' };
  const partyB = { kind: 'worker', id: 'member' };
  const january = new Date('2026-01-01T00:00:00Z');
  const february = new Date('2026-02-01T00:00:00Z');
  const march = new Date('2026-03-01T00:00:00Z');
  const create = (extra: Record<string, unknown> = {}) =>
    collection().create({
      kind,
      partyA: JSON.stringify(partyA),
      partyB: JSON.stringify(partyB),
      effectiveFrom: january,
      ...extra,
    });

  it.each([
    'superseded',
    'terminated',
  ] as const)('cannot reopen a %s historical interval', async (status) => {
    const row = await create({ status: 'active' });
    row.effectiveTo = march;
    if (status === 'superseded') row.supersede();
    else row.terminate(march);
    await row.save();
    const reloaded = await collection().get({ id: row.id });
    if (!reloaded) throw new Error('Missing agreement');
    reloaded.effectiveTo = null;
    await expect(reloaded.save()).rejects.toThrow(/effective interval/);
    expect(
      await collection().activeFor(kind, partyA, partyB, march),
    ).toBeNull();
  });

  it('does not permit direct active interval edits', async () => {
    const row = await create({ status: 'active' });
    row.effectiveTo = march;
    await expect(row.save()).rejects.toThrow(/effective interval/);
  });

  it('never makes cancelled draft terms govern', async () => {
    const row = await create();
    row.terminate();
    await row.save();
    expect(
      await collection().activeFor(kind, partyA, partyB, february),
    ).toBeNull();
  });

  it('canonicalizes equivalent party JSON before lookup and deduplication', async () => {
    const row = await create({
      status: 'active',
      partyA: JSON.stringify({ id: 'coop', kind: 'organization' }, null, 2),
    });
    expect(row.partyA).toBe(JSON.stringify(partyA));
    expect(
      (await collection().activeFor(kind, partyA, partyB, february))?.id,
    ).toBe(row.id);
    await expect(create({ status: 'active' })).rejects.toThrow();
  });

  it('rejects out-of-order amendment activation without altering history', async () => {
    const first = await create({ status: 'active' });
    const second = await collection().createAmendment(kind, partyA, partyB, {
      effectiveFrom: february,
    });
    const third = await collection().createAmendment(kind, partyA, partyB, {
      effectiveFrom: march,
    });
    await collection().activateAmendment(third.id as string);
    await expect(
      collection().activateAmendment(second.id as string),
    ).rejects.toThrow(/overlap/);
    expect((await collection().get({ id: second.id }))?.status).toBe('draft');
    expect(
      (await collection().activeFor(kind, partyA, partyB, february))?.id,
    ).toBe(first.id);
    expect(
      (await collection().activeFor(kind, partyA, partyB, march))?.id,
    ).toBe(third.id);
  });

  it('rejects backdating before the predecessor begins', async () => {
    const first = await create({ status: 'active' });
    const draft = await collection().createAmendment(kind, partyA, partyB, {
      effectiveFrom: new Date('2025-12-01T00:00:00Z'),
    });
    await expect(
      collection().activateAmendment(draft.id as string),
    ).rejects.toThrow(/overlap/);
    expect((await collection().get({ id: first.id }))?.status).toBe('active');
    expect(
      (await collection().activeFor(kind, partyA, partyB, february))?.id,
    ).toBe(first.id);
  });

  it('preserves global history before a tenant interval and while its row is draft', async () => {
    const global = await create({ status: 'active' });
    const tenantId = randomUUID();
    const draft = await create({ tenantId, effectiveFrom: february });
    expect(
      (await collection().activeFor(kind, partyA, partyB, march, tenantId))?.id,
    ).toBe(global.id);
    await collection().activateAmendment(draft.id as string);
    expect(
      (await collection().activeFor(kind, partyA, partyB, january, tenantId))
        ?.id,
    ).toBe(global.id);
    expect(
      (await collection().activeFor(kind, partyA, partyB, february, tenantId))
        ?.id,
    ).toBe(draft.id);
    expect((await collection().get({ id: global.id }))?.status).toBe('active');
  });

  it('requires an explicit tenant initial version before amending global-only terms', async () => {
    const global = await create({ status: 'active' });
    enableTenancy();
    try {
      await withTenant({ tenantId: randomUUID() }, async () => {
        await expect(
          collection().createAmendment(kind, partyA, partyB, {
            effectiveFrom: february,
          }),
        ).rejects.toThrow(/initial tenant agreement/);
        expect(
          (await collection().activeFor(kind, partyA, partyB, january))?.id,
        ).toBe(global.id);
      });
    } finally {
      disableTenancy();
    }
  });
  it.each([
    'terminated',
    'expired',
  ] as const)('does not restore global fees after tenant terms are %s', async (mode) => {
    const global = await create({ status: 'active' });
    const tenantId = randomUUID();
    const tenant = await create({
      tenantId,
      status: 'active',
      effectiveFrom: february,
      ...(mode === 'expired' ? { effectiveTo: march } : {}),
    });
    if (mode === 'terminated') {
      tenant.terminate(march);
      await tenant.save();
    }
    expect(
      (await collection().activeFor(kind, partyA, partyB, january, tenantId))
        ?.id,
    ).toBe(global.id);
    expect(
      (await collection().activeFor(kind, partyA, partyB, february, tenantId))
        ?.id,
    ).toBe(tenant.id);
    expect(
      await collection().activeFor(kind, partyA, partyB, march, tenantId),
    ).toBeNull();
  });

  const scheduled = new Date('2099-06-01T00:00:00Z');
  const finiteEnd = new Date('2099-12-01T00:00:00Z');
  async function schedule(end: Date | null = null) {
    const first = await create({ status: 'active', effectiveTo: end });
    const second = await collection().createAmendment(kind, partyA, partyB, {
      effectiveFrom: scheduled,
      effectiveTo: null,
    });
    await collection().activateAmendment(second.id as string);
    return { first, second };
  }

  it.each([
    null,
    finiteEnd,
  ])('withdraws a future amendment restoring the exact prior end %s', async (end) => {
    const { first, second } = await schedule(end);
    expect(
      (await collection().withdrawAmendment(second.id as string)).status,
    ).toBe('cancelled');
    const restored = await collection().get({ id: first.id });
    expect(restored?.status).toBe('active');
    expect(restored?.effectiveTo).toEqual(end);
    expect(
      (await collection().activeFor(kind, partyA, partyB, scheduled))?.id,
    ).toBe(first.id);
    expect(
      (await collection().activeFor(kind, partyA, partyB, january))?.id,
    ).toBe(first.id);
    await expect(
      collection().withdrawAmendment(second.id as string),
    ).rejects.toThrow(/scheduled active/);
    if (end)
      expect(
        await collection().activeFor(kind, partyA, partyB, end),
      ).toBeNull();
  });

  it('allows only one concurrent withdrawal and preserves history', async () => {
    const { first, second } = await schedule(finiteEnd);
    const results = await Promise.allSettled([
      collection().withdrawAmendment(second.id as string),
      collection().withdrawAmendment(second.id as string),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect((await collection().get({ id: first.id }))?.effectiveTo).toEqual(
      finiteEnd,
    );
    expect((await collection().get({ id: second.id }))?.status).toBe(
      'cancelled',
    );
  });

  it('refuses late withdrawal without changing either interval', async () => {
    const first = await create({ status: 'active' });
    const second = await collection().createAmendment(kind, partyA, partyB, {
      effectiveFrom: february,
    });
    await collection().activateAmendment(second.id as string);
    await expect(
      collection().withdrawAmendment(second.id as string),
    ).rejects.toThrow(/scheduled active/);
    expect((await collection().get({ id: first.id }))?.effectiveTo).toEqual(
      february,
    );
    expect((await collection().get({ id: second.id }))?.status).toBe('active');
  });

  it('rolls cancellation back when restoring the predecessor fails', async () => {
    const { first, second } = await schedule(finiteEnd);
    // Force the authoritative predecessor CAS to fail after the successor CAS,
    // by changing the observed object only. Persisted provenance stays intact.
    const initialize = Agreement.prototype.initialize;
    const spy = vi
      .spyOn(Agreement.prototype, 'initialize')
      .mockImplementation(async function (this: Agreement) {
        const result = await initialize.call(this);
        if (this.id === first.id) this.id = randomUUID();
        return result;
      });
    try {
      await expect(
        collection().withdrawAmendment(second.id as string),
      ).rejects.toThrow(/changed concurrently/);
    } finally {
      spy.mockRestore();
    }
    expect((await collection().get({ id: second.id }))?.status).toBe('active');
    expect((await collection().get({ id: first.id }))?.effectiveTo).toEqual(
      scheduled,
    );
  });
}
