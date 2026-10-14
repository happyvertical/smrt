import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import {
  migrateCommerceLineAmounts,
  rollbackCommerceLineAmounts,
} from '../migrations/commerceLineAmounts.js';
import { InvoiceStatus } from '../types/index.js';

describe('commerce line amount migration on PostgreSQL (#3933)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    db = await getTestDatabase({
      type: 'postgres',
      url: process.env.DATABASE_URL,
    });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  it('persists journal ownership and exact rollback on the managed adapter', async () => {
    const tenantId = randomUUID();
    const { invoice, line } = await withTenant({ tenantId }, async () => {
      const invoice = await (await InvoiceCollection.create({ db })).create({
        tenantId,
        invoiceNumber: 'PG-MIGRATION',
        status: InvoiceStatus.SENT,
        subtotal: 4_500,
        taxAmount: 225,
        totalAmount: 4_725,
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        tenantId,
        invoiceId: invoice.id,
        description: 'PostgreSQL line',
        quantity: 1,
        unitPrice: 4_500,
        taxRate: 0.05,
      });
      return { invoice, line };
    });
    const before = (
      await db.query('SELECT * FROM invoice_line_items WHERE id = ?', line.id)
    ).rows[0];
    const result = await migrateCommerceLineAmounts(db, { tenantId });
    expect(result.activated).toBe(true);
    expect(
      (
        await db.query(
          'SELECT state FROM commerce_money_migration_documents WHERE document_id = ?',
          invoice.id,
        )
      ).rows[0],
    ).toMatchObject({ state: 'applied' });
    await rollbackCommerceLineAmounts(db, {
      tenantId,
      migrationId: result.migrationId,
    });
    expect(
      (await db.query('SELECT * FROM invoice_line_items WHERE id = ?', line.id))
        .rows[0],
    ).toEqual(before);
  });
});
