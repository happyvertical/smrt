/** Tests generic agreement versions with a non-journalism worker-co-op fixture. */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgreementCollection } from '../collections/AgreementCollection.js';

const KIND = 'revenue_share';
const COOP = { kind: 'organization', id: 'worker-coop' };
const WORKER = { kind: 'worker', id: 'worker-17' };

describe('Agreement', () => {
  let db: DatabaseInterface;
  let agreements: AgreementCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    agreements = await AgreementCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  async function createDraft(overrides: Record<string, unknown> = {}) {
    return await agreements.create({
      kind: KIND,
      partyA: JSON.stringify(COOP),
      partyB: JSON.stringify(WORKER),
      version: 1,
      terms: JSON.stringify({ shareFraction: 0.25, currency: 'CAD' }),
      ...overrides,
    });
  }

  it('stores non-journalism counterparties and activates valid terms', async () => {
    const agreement = await createDraft();
    expect(agreement.getPartyA()).toEqual(COOP);
    expect(agreement.getPartyB()).toEqual(WORKER);
    expect(agreement.getTerms()).toEqual({
      shareFraction: 0.25,
      currency: 'CAD',
    });

    agreement.activate();
    await agreement.save();
    expect(agreement.status).toBe('active');

    const invalid = await createDraft({
      kind: 'invalid',
      partyA: '{}',
      terms: '[]',
    });
    expect(() => invalid.activate()).toThrow(/valid partyA and partyB/);
  });

  it('freezes active terms while allowing the supersession lifecycle edge', async () => {
    const agreement = await createDraft({
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    agreement.activate();
    await agreement.save();

    const reloaded = await agreements.get({ id: agreement.id });
    if (!reloaded) throw new Error('agreement not found');
    reloaded.setTerms({ shareFraction: 0.5, currency: 'CAD' });
    await expect(reloaded.save()).rejects.toThrow(/immutable once active/);

    const again = await agreements.get({ id: agreement.id });
    if (!again) throw new Error('agreement not found');
    again.supersede();
    await again.save();
    expect(again.status).toBe('superseded');
  });

  it('amends terms and resolves record-date history using half-open intervals', async () => {
    const v1 = await createDraft({
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    v1.activate();
    await v1.save();

    const v2 = await agreements.createAmendment(KIND, COOP, WORKER, {
      terms: { shareFraction: 0.35, currency: 'CAD' },
      effectiveFrom: new Date('2026-02-01T00:00:00Z'),
    });
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('draft');
    expect(v2.executedAgreementId).toBeNull();

    await agreements.activateAmendment(v2.id as string);
    const prior = await agreements.get({ id: v1.id });
    expect(prior?.status).toBe('superseded');
    expect(prior?.effectiveTo?.toISOString()).toBe('2026-02-01T00:00:00.000Z');

    const before = await agreements.activeFor(
      KIND,
      COOP,
      WORKER,
      new Date('2026-01-31T23:59:59Z'),
    );
    const boundary = await agreements.activeFor(
      KIND,
      COOP,
      WORKER,
      new Date('2026-02-01T00:00:00Z'),
    );
    expect(before?.version).toBe(1);
    expect(boundary?.version).toBe(2);
  });

  it('fails closed when imported effective intervals overlap', async () => {
    await createDraft({
      status: 'active',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    await createDraft({
      version: 2,
      status: 'active',
      effectiveFrom: new Date('2026-01-15T00:00:00Z'),
    });
    await expect(
      agreements.activeFor(
        KIND,
        COOP,
        WORKER,
        new Date('2026-01-20T00:00:00Z'),
      ),
    ).rejects.toThrow(/Agreement overlap/);
  });

  it('isolates same agreement identity by tenant and denies explicit cross-tenant reads', async () => {
    const a = await createDraft({ tenantId: 'tenant-a', status: 'active' });
    const b = await createDraft({ tenantId: 'tenant-b', status: 'active' });
    expect(a.id).not.toBe(b.id);
    expect(
      (await agreements.activeFor(KIND, COOP, WORKER, new Date(), 'tenant-a'))
        ?.id,
    ).toBe(a.id);

    enableTenancy();
    try {
      await expect(
        withTenant({ tenantId: 'tenant-a' }, () =>
          agreements.activeFor(KIND, COOP, WORKER, new Date(), 'tenant-b'),
        ),
      ).rejects.toThrow(/Tenant isolation violation/);
    } finally {
      disableTenancy();
    }
  });
});
