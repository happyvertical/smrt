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
import { ContractCollection } from '../collections/ContractCollection.js';
import { ContractLineItemCollection } from '../collections/ContractLineItemCollection.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { VendorCollection } from '../collections/VendorCollection.js';
import {
  COMMERCE_DATA_NEEDS_UPGRADE,
  ensureCommerceTenant,
  findCommerceMoneyUpgradeNeeds,
  upgradeCommerceMoney,
} from '../index.js';
import { deterministicTaxId } from '../tax/identity.js';
import { InvoiceStatus } from '../types/index.js';
import { forgetCommerceMoneyChecks } from '../upgrade/detect.js';

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
    forgetCommerceMoneyChecks();
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
      tenantlessDocuments: [],
      tenants: [],
    });
    // Nothing is left behind and a rerun is a no-op.
    expect(await upgradeCommerceMoney(db)).toEqual({
      upgraded: [],
      failures: [],
      droppedSchema: [],
      remaining: [],
      tenantlessDocuments: [],
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

  it('refuses a direct first settings row for a tenant with old documents', async () => {
    await ensureCommerceTenant(db, 'orphan');
    await oldInvoice('orphan', 'O-1', { issued: false });
    await db.query("DELETE FROM tax_settings WHERE tenant_id = 'orphan'");
    await restart();
    await expect(
      withTenant({ tenantId: 'orphan' }, async () =>
        (await TaxSettingsCollection.create({ db })).create({
          tenantId: 'orphan',
        }),
      ),
    ).rejects.toMatchObject({ code: COMMERCE_DATA_NEEDS_UPGRADE });
    expect(
      (await db.query("SELECT 1 FROM tax_settings WHERE tenant_id = 'orphan'"))
        .rows,
    ).toEqual([]);
  });

  it('refuses a first settings row stamped by tenancy for a tenant with old documents', async () => {
    await ensureCommerceTenant(db, 'stamped');
    await oldInvoice('stamped', 'S-1', { issued: false });
    // A zero-rate old draft: no row-level signal, only the missing settings.
    await db.query(
      "UPDATE invoice_line_items SET tax_rate = 0, amount = 200 WHERE tenant_id = 'stamped'",
    );
    await db.query("DELETE FROM tax_settings WHERE tenant_id = 'stamped'");
    await restart();
    await expect(
      withTenant({ tenantId: 'stamped' }, async () =>
        (await TaxSettingsCollection.create({ db })).create({}),
      ),
    ).rejects.toMatchObject({ code: COMMERCE_DATA_NEEDS_UPGRADE });
  });

  it('blocks on documents without a tenant until they are assigned', async () => {
    await ensureCommerceTenant(db, 'owner');
    const global = await oldInvoice('owner', 'G-1', { issued: true });
    await earlierSchema(['owner']);
    // An earlier version allowed tenantless documents.
    await db.query(
      'UPDATE invoices SET tenant_id = NULL WHERE id = ?',
      global.invoiceId,
    );
    await db.query(
      'UPDATE invoice_line_items SET tenant_id = NULL WHERE id = ?',
      global.lineId,
    );
    await restart();
    expect(
      (await findCommerceMoneyUpgradeNeeds(db)).tenantlessDocuments,
    ).toEqual([
      { table: 'invoices', id: global.invoiceId },
      { table: 'invoice_line_items', id: global.lineId },
    ]);
    const first = await upgradeCommerceMoney(db);
    expect(first.failures).toEqual([
      expect.objectContaining({
        tenantId: '',
        documentId: global.invoiceId,
        reason: expect.stringContaining('has no tenant'),
      }),
      expect.objectContaining({ tenantId: '', documentId: global.lineId }),
    ]);
    expect(first.droppedSchema).toEqual([]);

    // Even after the old columns are gone, a tenantless row refuses reads.
    for (const sql of [
      'ALTER TABLE tax_settings DROP COLUMN money_model',
      'ALTER TABLE tax_settings DROP COLUMN money_migration_id',
      'ALTER TABLE invoice_line_items DROP COLUMN legacy_amount',
      'ALTER TABLE contract_line_items DROP COLUMN legacy_amount',
      'DROP TABLE money_migration_documents',
    ])
      await db.query(sql);
    await restart();
    await expect(
      (await InvoiceCollection.create({ db })).list({}),
    ).rejects.toThrow(/without a tenant/);

    // Assigned to its tenant, it converts and the database is current.
    await db.query(
      "UPDATE invoices SET tenant_id = 'owner' WHERE id = ?",
      global.invoiceId,
    );
    await db.query(
      "UPDATE invoice_line_items SET tenant_id = 'owner' WHERE id = ?",
      global.lineId,
    );
    await restart();
    const second = await upgradeCommerceMoney(db);
    expect(second.failures).toEqual([]);
    expect(second.upgraded).toMatchObject([
      { tenantId: 'owner', issuedBackfilled: 1 },
    ]);
    expect(await readInvoices('owner')).toHaveLength(1);
  });

  it('keeps a current draft unchanged in a tenant it converts', async () => {
    await ensureCommerceTenant(db, 'mixed');
    const old = await oldInvoice('mixed', 'M-OLD', { issued: true });
    // A current inclusive draft with a 5% code, written by the runtime.
    const current = await withTenant({ tenantId: 'mixed' }, async () => {
      const component = await (
        await TaxComponentCollection.create({ db })
      ).create({ tenantId: 'mixed', name: 'GST', percent: '5' });
      const code = await (await TaxCodeCollection.create({ db })).create({
        tenantId: 'mixed',
        code: 'gst',
        name: 'GST',
        kind: 'taxable',
        components: [{ taxComponentId: String(component.id), compound: false }],
      });
      const settings = await (
        await TaxSettingsCollection.create({ db })
      ).getOrCreateForTenant('mixed');
      settings.defaultLineAmountType = 'inclusive';
      settings.defaultSalesTaxCodeId = String(code.id);
      await settings.save();
      const invoice = await (await InvoiceCollection.create({ db })).create({
        invoiceNumber: 'M-CURRENT',
        currency: 'CAD',
      });
      await (await InvoiceLineItemCollection.create({ db })).create({
        invoiceId: invoice.id,
        description: 'Inclusive',
        quantity: 1,
        unitPrice: 105,
      });
      return String(invoice.id);
    });
    await earlierSchema(['mixed']);
    await restart();
    const result = await upgradeCommerceMoney(db);
    expect(result.failures).toEqual([]);
    expect(result.upgraded[0]).toMatchObject({
      issuedBackfilled: 1,
      changedDrafts: [],
    });
    await withTenant({ tenantId: 'mixed' }, async () => {
      const invoices = await InvoiceCollection.create({ db });
      expect(await invoices.get({ id: current })).toMatchObject({
        lineAmountType: 'inclusive',
        subtotal: 100,
        taxAmount: 5,
        totalAmount: 105,
      });
      expect(await invoices.get({ id: old.invoiceId })).toMatchObject({
        totalAmount: 210,
      });
    });
  });

  it('maps an old zero-rate draft line explicitly so it does not inherit a default code', async () => {
    await ensureCommerceTenant(db, 'zero');
    const draft = await oldInvoice('zero', 'Z-1', { issued: false });
    await db.query(
      'UPDATE invoice_line_items SET tax_rate = 0, amount = 200 WHERE id = ?',
      draft.lineId,
    );
    await db.query(
      'UPDATE invoices SET tax_amount = 0, total_amount = 200 WHERE id = ?',
      draft.invoiceId,
    );
    // The tenant's default sales code taxes at 5%.
    await withTenant({ tenantId: 'zero' }, async () => {
      const component = await (
        await TaxComponentCollection.create({ db })
      ).create({ tenantId: 'zero', name: 'GST', percent: '5' });
      const code = await (await TaxCodeCollection.create({ db })).create({
        tenantId: 'zero',
        code: 'gst',
        name: 'GST',
        kind: 'taxable',
        components: [{ taxComponentId: String(component.id), compound: false }],
      });
      const settings = await (
        await TaxSettingsCollection.create({ db })
      ).getOrCreateForTenant('zero');
      settings.defaultSalesTaxCodeId = String(code.id);
      await settings.save();
    });
    await earlierSchema(['zero']);
    await restart();
    const result = await upgradeCommerceMoney(db);
    expect(result.failures).toEqual([]);
    expect(result.upgraded[0]?.changedDrafts).toEqual([]);
    await withTenant({ tenantId: 'zero' }, async () => {
      expect(
        await (await InvoiceCollection.create({ db })).get({
          id: draft.invoiceId,
        }),
      ).toMatchObject({ subtotal: 200, taxAmount: 0, totalAmount: 200 });
      const [line] = await (
        await InvoiceLineItemCollection.create({ db })
      ).findByInvoice(draft.invoiceId);
      expect(line).toMatchObject({ taxCodeCode: 'out-of-scope', taxAmount: 0 });
    });
  });

  it('backfills a taxed negative-price adjustment line with signed tax', async () => {
    await ensureCommerceTenant(db, 'signed');
    const ids = await withTenant({ tenantId: 'signed' }, async () => {
      const invoice = await (await InvoiceCollection.create({ db })).create({
        invoiceNumber: 'N-1',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      const charge = await lines.create({
        invoiceId: invoice.id,
        description: 'Charge',
        quantity: 2,
        unitPrice: 100,
      });
      const adjustment = await lines.create({
        invoiceId: invoice.id,
        description: 'Adjustment',
        quantity: 1,
        unitPrice: -100,
      });
      return {
        invoiceId: String(invoice.id),
        charge: String(charge.id),
        adjustment: String(adjustment.id),
      };
    });
    for (const [id, amount] of [
      [ids.charge, 210],
      [ids.adjustment, -105],
    ] as const)
      await db.query(
        `UPDATE invoice_line_items SET tax_rate = 0.05, amount = ?, tax_amount = 0,
                tax_code_id = NULL, tax_code_code = NULL, tax_code_name = NULL,
                tax_components_json = NULL, tax_mode = 'inherit', money_snapshot_id = ''
          WHERE id = ?`,
        amount,
        id,
      );
    await db.query(
      `UPDATE invoices SET status = 'sent', subtotal = 100, tax_amount = 5,
              total_amount = 105, money_snapshot_id = '' WHERE id = ?`,
      ids.invoiceId,
    );
    await db.query(
      'DELETE FROM document_taxes WHERE document_id = ?',
      ids.invoiceId,
    );
    await earlierSchema(['signed']);
    await restart();
    const result = await upgradeCommerceMoney(db);
    expect(result.failures).toEqual([]);
    const rows = (
      await db.query(
        'SELECT id, amount, tax_amount FROM invoice_line_items WHERE invoice_id = ? ORDER BY amount',
        ids.invoiceId,
      )
    ).rows as Array<Record<string, unknown>>;
    expect(rows.map((row) => [row.amount, row.tax_amount])).toEqual([
      [-100, -5],
      [200, 10],
    ]);
  });

  it('refuses an invoice posted under the earlier version and a colliding rate code', async () => {
    await ensureCommerceTenant(db, 'posted');
    await ensureCommerceTenant(db, 'collide');
    const posted = await oldInvoice('posted', 'P-1', { issued: true });
    await db.query(
      "UPDATE invoices SET ar_journal_id = '00000000-0000-4000-8000-00000000j001' WHERE id = ?",
      posted.invoiceId,
    );
    const drafted = await oldInvoice('collide', 'C-1', { issued: false });
    // A tenant already has a `rate-5` code that really means 10%.
    await withTenant({ tenantId: 'collide' }, async () => {
      const component = await (
        await TaxComponentCollection.create({ db })
      ).create({ tenantId: 'collide', name: 'Ten', percent: '10' });
      await (await TaxCodeCollection.create({ db })).create({
        tenantId: 'collide',
        code: 'rate-5',
        name: 'Not five',
        kind: 'taxable',
        components: [{ taxComponentId: String(component.id), compound: false }],
      });
    });
    await earlierSchema(['posted', 'collide']);
    await restart();
    const result = await upgradeCommerceMoney(db);
    expect(result.upgraded).toEqual([]);
    expect(result.failures).toEqual([
      {
        tenantId: 'collide',
        documentType: 'invoice',
        documentId: drafted.invoiceId,
        reason: expect.stringContaining(
          'tax code rate-5 already exists with different components',
        ),
      },
      {
        tenantId: 'posted',
        documentType: 'invoice',
        documentId: posted.invoiceId,
        reason: expect.stringContaining('posted under the earlier version'),
      },
    ]);
    expect(result.droppedSchema).toEqual([]);
  });

  it('refuses a document whose customer belongs to another tenant', async () => {
    await ensureCommerceTenant(db, 'mine');
    const foreign = await withTenant({ tenantId: 'theirs' }, async () =>
      (await CustomerCollection.create({ db })).create({ taxId: 'THEIR-TAX' }),
    );
    const ids = await oldInvoice('mine', 'X-1', { issued: true });
    await db.query(
      'UPDATE invoices SET customer_id = ? WHERE id = ?',
      String(foreign.id),
      ids.invoiceId,
    );
    await earlierSchema(['mine']);
    await restart();
    const result = await upgradeCommerceMoney(db);
    expect(result.failures).toEqual([
      expect.objectContaining({
        tenantId: 'mine',
        documentId: ids.invoiceId,
        reason: expect.stringContaining('of another tenant'),
      }),
    ]);
    const row = (
      await db.query(
        'SELECT party_tax_id FROM invoices WHERE id = ?',
        ids.invoiceId,
      )
    ).rows[0] as Record<string, unknown>;
    expect(row.party_tax_id || '').toBe('');
  });

  it('accumulates recoverable purchase tax line by line', async () => {
    await ensureCommerceTenant(db, 'buyer');
    const contractId = await withTenant({ tenantId: 'buyer' }, async () => {
      // An existing recoverable 5% component and its rate-5 code.
      const componentId = await deterministicTaxId(
        'buyer',
        'component',
        'rate-5',
      );
      await (await TaxComponentCollection.create({ db })).create({
        id: componentId,
        tenantId: 'buyer',
        name: '5%',
        percent: '5',
        recoverable: true,
      });
      await (await TaxCodeCollection.create({ db })).create({
        tenantId: 'buyer',
        code: 'rate-5',
        name: '5%',
        kind: 'taxable',
        components: [{ taxComponentId: componentId, compound: false }],
      });
      const vendor = await (await VendorCollection.create({ db })).create({
        name: 'Supplier',
      });
      const contract = await (await ContractCollection.create({ db })).create({
        _meta_type: 'PurchaseOrder',
        vendorId: vendor.id,
        currency: 'CAD',
      });
      const lines = await ContractLineItemCollection.create({ db });
      for (const unitPrice of [1, 200])
        await lines.create({
          contractId: contract.id,
          description: `Line ${unitPrice}`,
          quantity: 1,
          unitPrice,
        });
      return String(contract.id);
    });
    // Old format: 5% stored as a fraction; the 1-unit line rounds to no tax.
    await db.query(
      `UPDATE contract_line_items SET tax_rate = 0.05, tax_amount = 0,
              tax_code_id = NULL, tax_code_code = NULL, tax_code_name = NULL,
              tax_components_json = NULL, tax_mode = 'inherit', money_snapshot_id = '',
              amount = CASE WHEN unit_price = 1 THEN 1 ELSE 210 END
        WHERE contract_id = ?`,
      contractId,
    );
    await db.query(
      `UPDATE contracts SET status = 'sent', subtotal = 201, tax_amount = 10,
              total_amount = 211, money_snapshot_id = '' WHERE id = ?`,
      contractId,
    );
    await db.query(
      'DELETE FROM document_taxes WHERE document_id = ?',
      contractId,
    );
    await earlierSchema(['buyer']);
    await restart();
    const result = await upgradeCommerceMoney(db);
    expect(result.failures).toEqual([]);
    const taxes = await withTenant({ tenantId: 'buyer' }, async () =>
      (await DocumentTaxCollection.create({ db })).list({
        where: { documentId: contractId },
      }),
    );
    expect(
      taxes.map((row) => [
        row.taxableMinor,
        row.taxMinor,
        row.recoverableMinor,
      ]),
    ).toEqual([[201, 10, 10]]);
  });

  it('refuses a tenantless read of a database with old money storage', async () => {
    await ensureCommerceTenant(db, 'legacy');
    await oldInvoice('legacy', 'L-1', { issued: false });
    await earlierSchema(['legacy']);
    await restart();
    await expect(
      (await InvoiceCollection.create({ db })).list({}),
    ).rejects.toMatchObject({ code: COMMERCE_DATA_NEEDS_UPGRADE });
  });

  it('still finds old documents after a migration dropped the old columns', async () => {
    // An earlier-version legacy tenant: it has a settings row, and a
    // `db:migrate --drop-columns` removed every old column and table.
    await ensureCommerceTenant(db, 'dropped');
    const issued = await oldInvoice('dropped', 'D-ISSUED', { issued: true });
    const draft = await oldInvoice('dropped', 'D-DRAFT', { issued: false });
    await restart();
    expect(await findCommerceMoneyUpgradeNeeds(db)).toEqual({
      oldSchema: [],
      tenantlessDocuments: [],
      tenants: [{ tenantId: 'dropped', reason: 'old-format-documents' }],
    });
    await expect(readInvoices('dropped')).rejects.toMatchObject({
      code: COMMERCE_DATA_NEEDS_UPGRADE,
      message: expect.stringContaining(
        "Tenant dropped has commerce documents in an earlier version's money format.",
      ),
    });
    const result = await upgradeCommerceMoney(db);
    expect(result.failures).toEqual([]);
    expect(result.upgraded).toMatchObject([
      { tenantId: 'dropped', issuedBackfilled: 1, draftsRecomputed: 1 },
    ]);
    expect(await findCommerceMoneyUpgradeNeeds(db)).toEqual({
      oldSchema: [],
      tenantlessDocuments: [],
      tenants: [],
    });
    await withTenant({ tenantId: 'dropped' }, async () => {
      const invoices = await InvoiceCollection.create({ db });
      expect(await invoices.get({ id: issued.invoiceId })).toMatchObject({
        subtotal: 200,
        taxAmount: 10,
        totalAmount: 210,
      });
      expect(await invoices.get({ id: draft.invoiceId })).toMatchObject({
        subtotal: 200,
        taxAmount: 10,
        totalAmount: 210,
      });
    });
  });

  it('reconstructs a fractional-quantity net exactly, ties toward +infinity', async () => {
    await ensureCommerceTenant(db, 'fraction');
    const ids = await oldInvoice('fraction', 'F-1', { issued: true });
    // 1.005 x 100 = 100.5 exactly, which the earlier version stored as 101
    // (binary floating point would give 100.49999999999999 and round to 100).
    await db.query(
      `UPDATE invoice_line_items SET quantity = 1.005, unit_price = 100,
              tax_rate = 0, amount = 101 WHERE id = ?`,
      ids.lineId,
    );
    await db.query(
      'UPDATE invoices SET subtotal = 101, tax_amount = 0, total_amount = 101 WHERE id = ?',
      ids.invoiceId,
    );
    await earlierSchema(['fraction']);
    await restart();
    const result = await upgradeCommerceMoney(db);
    expect(result.failures).toEqual([]);
    const line = (
      await db.query(
        'SELECT amount, tax_amount, tax_code_code FROM invoice_line_items WHERE id = ?',
        ids.lineId,
      )
    ).rows[0] as Record<string, unknown>;
    expect(line).toMatchObject({
      amount: 101,
      tax_amount: 0,
      tax_code_code: 'out-of-scope',
    });
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
