/**
 * Old-format commerce money data: detection, hard fail and the one-shot
 * upgrade (#4021). Fixtures are written with the current runtime, then
 * rewritten in raw SQL to the shape an earlier version stored (tax-inclusive
 * line amounts, a fractional tax rate, no tax amounts, codes or snapshots)
 * and given back the earlier schema's columns.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import {
  COMMERCE_DATA_NEEDS_UPGRADE,
  ensureCommerceTenant,
  findCommerceMoneyUpgradeNeeds,
  upgradeCommerceMoney,
} from '../index.js';
import { InvoiceStatus } from '../types/index.js';

const OLD_COLUMNS = [
  "ALTER TABLE tax_settings ADD COLUMN money_model TEXT NOT NULL DEFAULT 'legacy'",
  "ALTER TABLE tax_settings ADD COLUMN money_migration_id TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE invoice_line_items ADD COLUMN legacy_amount INTEGER',
  'ALTER TABLE contract_line_items ADD COLUMN legacy_amount INTEGER',
  'CREATE TABLE money_migration_documents (id TEXT PRIMARY KEY)',
];

describe('commerce money upgrade (#4021)', () => {
  let db: DatabaseInterface;
  let dir: string;
  let url: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'commerce-money-upgrade-'));
    url = join(dir, 'app.db');
    db = await getTestDatabase({ type: 'sqlite', url });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Old-format data exists before the process starts: reopen the database so
   * nothing proven while writing the fixtures is cached.
   */
  async function restart(): Promise<void> {
    await db.close?.();
    db = await getTestDatabase({ type: 'sqlite', url });
  }

  /**
   * One invoice with one line (2 x 100), rewritten to the earlier format:
   * a 5% rate, the tax-inclusive amount and the stored header totals.
   */
  async function oldInvoice(
    tenantId: string,
    number: string,
    options: { issued: boolean; headerTax?: number },
  ): Promise<{ invoiceId: string; lineId: string }> {
    const ids = await withTenant({ tenantId }, async () => {
      const invoice = await (await InvoiceCollection.create({ db })).create({
        invoiceNumber: number,
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        invoiceId: invoice.id,
        description: `${number} line`,
        quantity: 2,
        unitPrice: 100,
      });
      return { invoiceId: String(invoice.id), lineId: String(line.id) };
    });
    const headerTax = options.headerTax ?? 10;
    await db.query(
      `UPDATE invoice_line_items
          SET tax_rate = 0.05, amount = 210, tax_amount = 0, tax_code_id = NULL,
              tax_code_code = NULL, tax_code_name = NULL, tax_components_json = NULL,
              tax_mode = 'inherit', money_snapshot_id = ''
        WHERE id = ?`,
      ids.lineId,
    );
    await db.query(
      `UPDATE invoices
          SET status = ?, subtotal = 200, tax_amount = ?, total_amount = ?,
              money_snapshot_id = ''
        WHERE id = ?`,
      options.issued ? InvoiceStatus.SENT : InvoiceStatus.DRAFT,
      headerTax,
      200 + headerTax,
      ids.invoiceId,
    );
    await db.query(
      'DELETE FROM document_taxes WHERE document_id = ?',
      ids.invoiceId,
    );
    return ids;
  }

  /** The earlier version's schema, with `tenantId` on its legacy marker. */
  async function earlierSchema(legacyTenants: string[]): Promise<void> {
    for (const sql of OLD_COLUMNS) await db.query(sql);
    await db.query("UPDATE tax_settings SET money_model = 'v2'");
    for (const tenantId of legacyTenants)
      await db.query(
        "UPDATE tax_settings SET money_model = 'legacy' WHERE tenant_id = ?",
        tenantId,
      );
  }

  const readInvoices = (tenantId: string) =>
    withTenant({ tenantId }, async () =>
      (await InvoiceCollection.create({ db })).list({}),
    );

  it('refuses old-format data, upgrades it once, then runs on the current model', async () => {
    // legacy: an earlier-version legacy tenant; current: already v2;
    // orphan: documents written before tenant tax settings existed;
    // broken: an issued invoice whose lines do not add up to its header.
    for (const tenantId of ['legacy', 'current', 'orphan', 'broken'])
      await ensureCommerceTenant(db, tenantId);
    const issued = await oldInvoice('legacy', 'L-ISSUED', { issued: true });
    const draft = await oldInvoice('legacy', 'L-DRAFT', { issued: false });
    await oldInvoice('orphan', 'O-ISSUED', { issued: true });
    const broken = await oldInvoice('broken', 'B-ISSUED', {
      issued: true,
      headerTax: 11,
    });
    await db.query("DELETE FROM tax_settings WHERE tenant_id = 'orphan'");
    await earlierSchema(['legacy', 'broken']);
    await restart();

    // Detection: the whole database and every tenant to convert.
    const status = await findCommerceMoneyUpgradeNeeds(db);
    expect(status.oldSchema).toEqual([
      'contract_line_items.legacy_amount',
      'invoice_line_items.legacy_amount',
      'money_migration_documents',
      'tax_settings.money_migration_id',
      'tax_settings.money_model',
    ]);
    expect(status.tenants).toEqual([
      { tenantId: 'broken', reason: 'legacy-marker' },
      { tenantId: 'legacy', reason: 'legacy-marker' },
      { tenantId: 'orphan', reason: 'missing-settings' },
    ]);

    // Hard fail: even an already-current tenant is refused until the
    // database is upgraded, with the code and the exact command.
    await expect(readInvoices('current')).rejects.toMatchObject({
      code: COMMERCE_DATA_NEEDS_UPGRADE,
      message: expect.stringContaining('Run smrt db:upgrade-commerce-money'),
    });
    await expect(readInvoices('legacy')).rejects.toThrow(
      /COMMERCE_DATA_NEEDS_UPGRADE: The database holds commerce money data from an earlier version/,
    );

    // The unreconcilable tenant fails and is listed; the others convert.
    const first = await upgradeCommerceMoney(db);
    expect(first.failures).toEqual([
      {
        tenantId: 'broken',
        documentType: 'invoice',
        documentId: broken.invoiceId,
        reason: expect.stringContaining(
          'does not reconcile: line tax 10 plus provider tax 0 differs from stored tax 11',
        ),
      },
    ]);
    expect(first.upgraded.map((tenant) => tenant.tenantId)).toEqual([
      'legacy',
      'orphan',
    ]);
    expect(first.upgraded[0]).toMatchObject({
      issuedBackfilled: 1,
      draftsRecomputed: 1,
      changedDrafts: [],
    });
    expect(first.remaining).toEqual([
      { tenantId: 'broken', reason: 'legacy-marker' },
    ]);
    expect(first.droppedSchema).toEqual([]);
    // The broken tenant changed nothing, and the database is still refused.
    const brokenRow = (
      await db.query(
        'SELECT tax_code_id, money_snapshot_id FROM invoice_line_items WHERE id = ?',
        broken.lineId,
      )
    ).rows[0] as Record<string, unknown>;
    expect(brokenRow).toEqual({ tax_code_id: null, money_snapshot_id: '' });
    await expect(readInvoices('legacy')).rejects.toMatchObject({
      code: COMMERCE_DATA_NEEDS_UPGRADE,
    });

    // Once the data is fixed, a rerun converts it and removes the old schema.
    await db.query(
      'UPDATE invoices SET tax_amount = 10, total_amount = 210 WHERE id = ?',
      broken.invoiceId,
    );
    const second = await upgradeCommerceMoney(db);
    expect(second.failures).toEqual([]);
    expect(second.upgraded.map((tenant) => tenant.tenantId)).toEqual([
      'broken',
    ]);
    expect(second.droppedSchema).toEqual(status.oldSchema);
    expect(second.remaining).toEqual([]);
    expect(await findCommerceMoneyUpgradeNeeds(db)).toEqual({
      oldSchema: [],
      tenants: [],
    });
    // Nothing is left behind and a rerun is a no-op.
    expect(await upgradeCommerceMoney(db)).toEqual({
      upgraded: [],
      failures: [],
      droppedSchema: [],
      remaining: [],
    });

    // The issued invoice kept every stored total and gained v2 facts.
    await withTenant({ tenantId: 'legacy' }, async () => {
      const invoices = await InvoiceCollection.create({ db });
      const stored = await invoices.get({ id: issued.invoiceId });
      expect(stored).toMatchObject({
        status: InvoiceStatus.SENT,
        subtotal: 200,
        taxAmount: 10,
        totalAmount: 210,
        lineAmountType: 'exclusive',
        taxRoundingScope: 'line',
      });
      expect(stored?.moneySnapshotId).toBeTruthy();
      const rate = await (await TaxCodeCollection.create({ db })).findByCode(
        'rate-5',
        'legacy',
      );
      expect(rate?.name).toBe('5%');
      const [line] = await (
        await InvoiceLineItemCollection.create({ db })
      ).findByInvoice(issued.invoiceId);
      expect(line).toMatchObject({
        amount: 200,
        taxAmount: 10,
        taxMode: 'override',
        taxCodeId: rate?.id,
        taxCodeCode: 'rate-5',
        moneySnapshotId: stored?.moneySnapshotId,
      });
      const taxes = await (await DocumentTaxCollection.create({ db })).list({
        where: { documentId: issued.invoiceId },
      });
      expect(
        taxes.map((row) => [row.taxCodeCode, row.taxableMinor, row.taxMinor]),
      ).toEqual([['rate-5', 200, 10]]);

      // The runtime works: the issued invoice is frozen, the draft is live.
      if (!stored) throw new Error('Expected the issued invoice');
      stored.subtotal = 1;
      await expect(stored.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });
      const [draftLine] = await (
        await InvoiceLineItemCollection.create({ db })
      ).findByInvoice(draft.invoiceId);
      expect(draftLine).toMatchObject({
        amount: 200,
        taxAmount: 10,
        taxCodeCode: 'rate-5',
      });
      if (!draftLine) throw new Error('Expected the draft line');
      draftLine.quantity = 3;
      await draftLine.save();
      expect(await invoices.get({ id: draft.invoiceId })).toMatchObject({
        subtotal: 300,
        taxAmount: 15,
        totalAmount: 315,
      });
    });

    // The orphan tenant gained settings and its standard codes.
    await withTenant({ tenantId: 'orphan' }, async () => {
      expect(
        await (await TaxSettingsCollection.create({ db })).getForTenant(
          'orphan',
        ),
      ).toBeTruthy();
      expect(await readInvoices('orphan')).toHaveLength(1);
    });
  });

  it('refuses a tenant whose documents predate tenant tax settings', async () => {
    await ensureCommerceTenant(db, 'orphan');
    await oldInvoice('orphan', 'O-1', { issued: false });
    await db.query("DELETE FROM tax_settings WHERE tenant_id = 'orphan'");
    await restart();

    await expect(readInvoices('orphan')).rejects.toMatchObject({
      code: COMMERCE_DATA_NEEDS_UPGRADE,
      message:
        'COMMERCE_DATA_NEEDS_UPGRADE: Tenant orphan has commerce documents but no tenant tax settings. Run smrt db:upgrade-commerce-money --tenant-id orphan to upgrade it.',
    });
    await expect(ensureCommerceTenant(db, 'orphan')).rejects.toMatchObject({
      code: COMMERCE_DATA_NEEDS_UPGRADE,
    });
    // A clean tenant is unaffected.
    await expect(ensureCommerceTenant(db, 'fresh')).resolves.toEqual({
      tenantId: 'fresh',
    });

    const result = await upgradeCommerceMoney(db, { tenantId: 'orphan' });
    expect(result.failures).toEqual([]);
    expect(result.upgraded[0]).toMatchObject({
      tenantId: 'orphan',
      draftsRecomputed: 1,
    });
    expect(await readInvoices('orphan')).toHaveLength(1);
  });

  it('refuses an invalid stored rate and an interrupted earlier migration', async () => {
    await ensureCommerceTenant(db, 'rate');
    await ensureCommerceTenant(db, 'migrating');
    const bad = await oldInvoice('rate', 'R-1', { issued: false });
    await db.query(
      'UPDATE invoice_line_items SET tax_rate = 1.5 WHERE id = ?',
      bad.lineId,
    );
    await earlierSchema(['rate']);
    await db.query(
      "UPDATE tax_settings SET money_model = 'migrating', money_migration_id = 'm-1' WHERE tenant_id = 'migrating'",
    );

    const result = await upgradeCommerceMoney(db);
    expect(result.upgraded).toEqual([]);
    expect(result.failures).toEqual([
      {
        tenantId: 'migrating',
        documentType: null,
        documentId: '',
        reason: expect.stringContaining('never finished'),
      },
      {
        tenantId: 'rate',
        documentType: 'invoice',
        documentId: bad.invoiceId,
        reason: 'stored tax rate 1.5 is not a valid rate',
      },
    ]);
    expect(result.droppedSchema).toEqual([]);
  });
});
