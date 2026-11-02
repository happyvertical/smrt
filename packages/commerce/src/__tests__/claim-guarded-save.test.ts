/**
 * Revision-guarded `save()` on models that claim (advance) their own row's
 * revision before persisting (#4408). Forwarding the caller's ORIGINAL
 * `expectedUpdatedAt` after the claim made every uncontended guarded save
 * conflict; the claim must be the compare-and-swap against the caller's
 * revision and the final write must expect the revision the claim wrote.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';

const TENANT = 'claim-guarded-save-tenant';
const STALE = '2000-01-01T00:00:00.000Z';

describe('claim-then-save models honour expectedUpdatedAt (#4408)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  it('Payment.save: current revision succeeds, stale rejects unchanged', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const payments = await PaymentCollection.create({ db });
      const created = await payments.create({ amount: 100 });
      await created.save();
      const load = () => payments.get({ id: created.id }, { cache: false });

      const stale = await load();
      if (!stale) throw new Error('expected row');
      stale.notes = 'stale-write';
      await expect(
        stale.save({ expectedUpdatedAt: STALE }),
      ).rejects.toMatchObject({ code: 'RUNTIME_REVISION_CONFLICT' });
      expect((await load())?.notes).toBe('');

      const fresh = await load();
      if (!fresh?.updated_at) throw new Error('expected persisted revision');
      fresh.notes = 'current-write';
      await fresh.save({ expectedUpdatedAt: fresh.updated_at });
      expect((await load())?.notes).toBe('current-write');
    });
  });

  it('TaxComponent.save: guarded rate edit honours the caller revision', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const created = await components.create({ name: 'GST', percent: '5' });
      const load = () => components.get({ id: created.id }, { cache: false });

      const stale = await load();
      if (!stale) throw new Error('expected row');
      stale.percent = '7';
      await expect(
        stale.save({ expectedUpdatedAt: STALE }),
      ).rejects.toMatchObject({ code: 'RUNTIME_REVISION_CONFLICT' });
      expect((await load())?.percent).toBe('5');

      const fresh = await load();
      if (!fresh?.updated_at) throw new Error('expected persisted revision');
      fresh.percent = '7';
      await fresh.save({ expectedUpdatedAt: fresh.updated_at });
      expect((await load())?.percent).toBe('7');
    });
  });

  it('TaxComponent.save: a referenced rate stays immutable under a guard', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const created = await components.create({ name: 'PST', percent: '5' });
      const codes = await TaxCodeCollection.create({ db });
      await codes.create({
        code: 'pst',
        name: 'PST',
        components: [{ taxComponentId: created.id, compound: false }],
      });
      const row = await components.get({ id: created.id }, { cache: false });
      if (!row?.updated_at) throw new Error('expected persisted revision');
      row.percent = '9';
      await expect(
        row.save({ expectedUpdatedAt: row.updated_at }),
      ).rejects.toThrow(/immutable/);
    });
  });
});
