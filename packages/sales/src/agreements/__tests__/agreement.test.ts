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

  it('does not resolve drafts and end-dates terminated terms', async () => {
    const active = await createDraft({ status: 'active' });
    const draft = await createDraft({
      version: 2,
      effectiveFrom: new Date('2026-02-01T00:00:00Z'),
    });
    expect(
      await agreements.activeFor(
        KIND,
        COOP,
        WORKER,
        new Date('2026-02-02T00:00:00Z'),
      ),
    ).toMatchObject({ id: active.id });
    expect(draft.status).toBe('draft');
    active.terminate(new Date('2026-03-01T00:00:00Z'));
    await active.save();
    expect(
      await agreements.activeFor(
        KIND,
        COOP,
        WORKER,
        new Date('2026-03-01T00:00:00Z'),
      ),
    ).toBeNull();
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

  it('keeps amendments and default reads in the ambient tenant lane with global fallback', async () => {
    const global = await createDraft({ tenantId: null, status: 'active' });
    const a = await createDraft({ tenantId: 'tenant-a', status: 'active' });
    const b = await createDraft({ tenantId: 'tenant-b', status: 'active' });

    enableTenancy();
    try {
      await withTenant({ tenantId: 'tenant-a' }, async () => {
        expect((await agreements.activeFor(KIND, COOP, WORKER))?.id).toBe(a.id);
        const amendment = await agreements.createAmendment(KIND, COOP, WORKER, {
          effectiveFrom: new Date('2026-02-01T00:00:00Z'),
        });
        expect(amendment.tenantId).toBe('tenant-a');
        await agreements.activateAmendment(amendment.id as string);
      });
      expect((await agreements.get({ id: b.id }))?.status).toBe('active');
    } finally {
      disableTenancy();
    }

    const globalAmendment = await agreements.createAmendment(
      KIND,
      COOP,
      WORKER,
    );
    expect(globalAmendment.tenantId).toBeNull();
    expect(global.id).toBeTruthy();
  });

  it('uses global terms when an ambient tenant has no agreement', async () => {
    const global = await createDraft({ tenantId: null, status: 'active' });
    enableTenancy();
    try {
      await withTenant({ tenantId: 'tenant-a' }, async () => {
        expect((await agreements.activeFor(KIND, COOP, WORKER))?.id).toBe(
          global.id,
        );
      });
    } finally {
      disableTenancy();
    }
  });
  it('activates an operator-owned tenant draft without superseding global terms', async () => {
    const tenantId = 'tenant-a';
    const initial = {
      kind: KIND,
      partyA: JSON.stringify(COOP),
      partyB: JSON.stringify(WORKER),
      version: 1,
      status: 'active' as const,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    };
    const global = await agreements.create(initial);
    const prior = await agreements.create({ ...initial, tenantId });
    const draft = await agreements.create({
      ...initial,
      tenantId,
      version: 2,
      status: 'draft',
      effectiveFrom: new Date('2026-02-01T00:00:00Z'),
    });
    await agreements.activateAmendment(draft.id as string);
    expect((await agreements.get({ id: prior.id }))?.status).toBe('superseded');
    expect((await agreements.get({ id: global.id }))?.status).toBe('active');
    expect((await agreements.get({ id: global.id }))?.effectiveTo).toBeNull();
  });
});
