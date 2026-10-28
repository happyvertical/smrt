/**
 * Money-document `save(options)` forwarding (#4408).
 *
 * Invoice, InvoiceLineItem, Contract, and ContractLineItem route `save()`
 * through aggregate helpers that persist several rows. The caller's
 * `expectedUpdatedAt` guards the row the caller saved, so a stale revision must
 * reject with `RUNTIME_REVISION_CONFLICT` and leave the stored row unchanged.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import { ContractLineItemCollection } from '../collections/ContractLineItemCollection.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { ensureTenantTaxCodes } from '../tax/standard-codes.js';

const TENANT = 'save-options-tenant';
const STALE = '2000-01-01T00:00:00.000Z';

interface Revisioned {
  updated_at?: Date | string | null;
  save(options?: { expectedUpdatedAt?: Date | string }): Promise<unknown>;
}

describe('money-document save() forwards SmrtSaveOptions (#4408)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    await ensureTenantTaxCodes(db, TENANT);
    await withTenant({ tenantId: TENANT }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const gst = await components.create({ name: 'GST', percent: '5' });
      const codes = await TaxCodeCollection.create({ db });
      const code = await codes.create({
        code: 'gst',
        name: 'GST',
        components: [{ taxComponentId: gst.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const current = await settings.getOrCreateForTenant(TENANT);
      current.defaultSalesTaxCodeId = code.id;
      current.defaultLineAmountType = 'exclusive';
      current.taxRoundingScope = 'document';
      await current.save();
    });
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  /**
   * Another writer advances the stored revision; a caller holding the fresh
   * in-memory row but a stale `expectedUpdatedAt` must be rejected (the
   * in-memory revision alone would let the write through), leaving the stored
   * row and the in-memory revision untouched. The current revision succeeds.
   */
  async function expectGuarded<T extends Revisioned>(
    load: () => Promise<T | null>,
    mutate: (row: T, value: string) => void,
    read: (row: T) => string,
  ): Promise<void> {
    const loaded = await load();
    const other = await load();
    if (!loaded || !other) throw new Error('expected persisted row');
    const stale = loaded.updated_at;
    if (!stale) throw new Error('expected persisted revision');

    mutate(other, 'changed-elsewhere');
    await other.save();

    const current = await load();
    if (!current?.updated_at) throw new Error('expected persisted revision');
    const currentRevision = new Date(current.updated_at).getTime();
    expect(currentRevision).toBeGreaterThan(new Date(stale).getTime());

    mutate(current, 'stale-write');
    for (const expectedUpdatedAt of [STALE, stale]) {
      await expect(current.save({ expectedUpdatedAt })).rejects.toMatchObject({
        code: 'RUNTIME_REVISION_CONFLICT',
      });
    }
    // A conflict leaves the in-memory revision at what the caller loaded.
    expect(new Date(current.updated_at).getTime()).toBe(currentRevision);
    const unchanged = await load();
    expect(unchanged && read(unchanged)).toBe('changed-elsewhere');

    mutate(current, 'current-write');
    await current.save({ expectedUpdatedAt: current.updated_at });
    const stored = await load();
    expect(stored && read(stored)).toBe('current-write');
  }

  it('Invoice.save forwards expectedUpdatedAt', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const customer = await (await CustomerCollection.create({ db })).create(
        {},
      );
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'INV-SO-1',
        currency: 'CAD',
      });
      await expectGuarded(
        () => invoices.get({ id: invoice.id }, { cache: false }),
        (row, value) => {
          row.notes = value;
        },
        (row) => row.notes,
      );
    });
  });

  it('InvoiceLineItem.save forwards expectedUpdatedAt', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const customer = await (await CustomerCollection.create({ db })).create(
        {},
      );
      const invoice = await (await InvoiceCollection.create({ db })).create({
        customerId: customer.id,
        invoiceNumber: 'INV-SO-2',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      const line = await lines.create({
        invoiceId: invoice.id,
        description: 'Service',
        quantity: 1,
        unitPrice: 100,
        revenueAccountId: 'revenue',
      });
      await expectGuarded(
        () => lines.get({ id: line.id }, { cache: false }),
        (row, value) => {
          row.description = value;
        },
        (row) => row.description,
      );
    });
  });

  it('Contract.save forwards expectedUpdatedAt', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const contracts = await ContractCollection.create({ db });
      const contract = await contracts.create({ currency: 'CAD' });
      await expectGuarded(
        () => contracts.get({ id: contract.id }, { cache: false }),
        (row, value) => {
          row.notes = value;
        },
        (row) => row.notes,
      );
    });
  });

  it('ContractLineItem.save forwards expectedUpdatedAt', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const contract = await (await ContractCollection.create({ db })).create({
        currency: 'CAD',
      });
      const lines = await ContractLineItemCollection.create({ db });
      const line = await lines.create({
        contractId: contract.id,
        description: 'Service',
        quantity: 1,
        unitPrice: 100,
      });
      await expectGuarded(
        () => lines.get({ id: line.id }, { cache: false }),
        (row, value) => {
          row.description = value;
        },
        (row) => row.description,
      );
    });
  });
});
