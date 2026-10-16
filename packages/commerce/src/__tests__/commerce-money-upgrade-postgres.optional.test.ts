/**
 * PostgreSQL parity for old-format money detection and the one-shot upgrade
 * (#4021): the catalog probe, row-policy-independent scans, the per-tenant
 * transaction and the schema drop. Test files run sequentially; this file
 * restores the shared schema in `afterEach`.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import {
  COMMERCE_DATA_NEEDS_UPGRADE,
  ensureCommerceTenant,
  findCommerceMoneyUpgradeNeeds,
  upgradeCommerceMoney,
} from '../index.js';
import { InvoiceStatus } from '../types/index.js';
import { forgetCommerceMoneyChecks } from '../upgrade/detect.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

const OLD_COLUMNS = [
  "ALTER TABLE tax_settings ADD COLUMN IF NOT EXISTS money_model TEXT NOT NULL DEFAULT 'legacy'",
  "ALTER TABLE tax_settings ADD COLUMN IF NOT EXISTS money_migration_id TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS legacy_amount INTEGER',
  'ALTER TABLE contract_line_items ADD COLUMN IF NOT EXISTS legacy_amount INTEGER',
  'CREATE TABLE IF NOT EXISTS commerce_money_migration_documents (id TEXT PRIMARY KEY)',
];

const RESTORE = [
  'ALTER TABLE tax_settings DROP COLUMN IF EXISTS money_model',
  'ALTER TABLE tax_settings DROP COLUMN IF EXISTS money_migration_id',
  'ALTER TABLE invoice_line_items DROP COLUMN IF EXISTS legacy_amount',
  'ALTER TABLE contract_line_items DROP COLUMN IF EXISTS legacy_amount',
  'DROP TABLE IF EXISTS commerce_money_migration_documents',
  ...['invoices', 'invoice_line_items', 'tax_settings'].flatMap((table) => [
    `DROP POLICY IF EXISTS smrt_4021_system_only ON ${table}`,
    `ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`,
  ]),
];

/** Rows visible and writable only in system context, as the generated policies. */
async function systemOnly(db: DatabaseInterface, table: string): Promise<void> {
  await db.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await db.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  await db.query(
    `CREATE POLICY smrt_4021_system_only ON ${table} USING (COALESCE(NULLIF(current_setting('smrt.system_context', true), ''), 'false')::boolean)`,
  );
}

describePostgres('commerce money upgrade on PostgreSQL (#4021)', () => {
  let db: DatabaseInterface;

  const open = () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    return getTestDatabase({ type: 'postgres', url: process.env.DATABASE_URL });
  };

  beforeEach(async () => {
    db = await open();
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    for (const sql of RESTORE) await db.query(sql);
    await db?.close?.();
  });

  /** A fresh connection: nothing proven on the previous one is cached. */
  async function restart(): Promise<void> {
    forgetCommerceMoneyChecks();
    await db.close?.();
    db = await open();
  }

  async function oldInvoice(tenantId: string, issued: boolean) {
    const ids = await withTenant({ tenantId }, async () => {
      const invoice = await (await InvoiceCollection.create({ db })).create({
        invoiceNumber: `PG-${randomUUID().slice(0, 8)}`,
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        invoiceId: invoice.id,
        description: 'PG old line',
        quantity: 2,
        unitPrice: 100,
      });
      return { invoiceId: String(invoice.id), lineId: String(line.id) };
    });
    await db.query(
      `UPDATE invoice_line_items
          SET tax_rate = 0.05, amount = 210, tax_amount = 0, tax_code_id = NULL,
              tax_mode = 'inherit', money_snapshot_id = ''
        WHERE CAST(id AS TEXT) = ?`,
      ids.lineId,
    );
    await db.query(
      `UPDATE invoices
          SET status = ?, subtotal = 200, tax_amount = 10, total_amount = 210,
              money_snapshot_id = ''
        WHERE CAST(id AS TEXT) = ?`,
      issued ? InvoiceStatus.SENT : InvoiceStatus.DRAFT,
      ids.invoiceId,
    );
    await db.query(
      'DELETE FROM document_taxes WHERE CAST(document_id AS TEXT) = ?',
      ids.invoiceId,
    );
    return ids;
  }

  it('detects, refuses and upgrades a legacy tenant, then drops the old schema', async () => {
    const legacy = randomUUID();
    const current = randomUUID();
    await ensureCommerceTenant(db, legacy);
    await ensureCommerceTenant(db, current);
    const issued = await oldInvoice(legacy, true);
    await oldInvoice(legacy, false);
    for (const sql of OLD_COLUMNS) await db.query(sql);
    await db.query("UPDATE tax_settings SET money_model = 'v2'");
    await db.query(
      "UPDATE tax_settings SET money_model = 'legacy' WHERE CAST(tenant_id AS TEXT) = ?",
      legacy,
    );
    await restart();

    const status = await findCommerceMoneyUpgradeNeeds(db);
    expect(status.oldSchema).toEqual([
      'commerce_money_migration_documents',
      'contract_line_items.legacy_amount',
      'invoice_line_items.legacy_amount',
      'tax_settings.money_migration_id',
      'tax_settings.money_model',
    ]);
    expect(status.tenants).toContainEqual({
      tenantId: legacy,
      reason: 'legacy-marker',
    });
    await expect(
      withTenant({ tenantId: current }, async () =>
        (await InvoiceCollection.create({ db })).list({}),
      ),
    ).rejects.toMatchObject({ code: COMMERCE_DATA_NEEDS_UPGRADE });

    const result = await upgradeCommerceMoney(db, { tenantId: legacy });
    expect(result.failures).toEqual([]);
    expect(result.upgraded).toMatchObject([
      { tenantId: legacy, issuedBackfilled: 1, draftsRecomputed: 1 },
    ]);
    const after = await findCommerceMoneyUpgradeNeeds(db);
    expect(after.tenants.map((need) => need.tenantId)).not.toContain(legacy);
    // Earlier test files may leave tenants of their own; the schema is
    // dropped only once none remain.
    if (after.tenants.length === 0) expect(after.oldSchema).toEqual([]);
    else expect(result.droppedSchema).toEqual([]);

    const line = (
      await db.query(
        `SELECT amount, tax_amount, tax_code_code, money_snapshot_id
           FROM invoice_line_items WHERE CAST(id AS TEXT) = ?`,
        issued.lineId,
      )
    ).rows[0] as Record<string, unknown>;
    expect(Number(line.amount)).toBe(200);
    expect(Number(line.tax_amount)).toBe(10);
    expect(line.tax_code_code).toBe('rate-5');
    expect(line.money_snapshot_id).toBeTruthy();
  });

  it('sees documents a caller cannot read under row policies', async () => {
    const tenantId = randomUUID();
    await ensureCommerceTenant(db, tenantId);
    await oldInvoice(tenantId, false);
    await db.query(
      'DELETE FROM tax_settings WHERE CAST(tenant_id AS TEXT) = ?',
      tenantId,
    );
    // Model a principal without invoice read permission: rows are visible
    // only in system context, as with the generated permission policies.
    await systemOnly(db, 'invoices');
    await restart();
    expect(
      (
        await db.query(
          'SELECT 1 FROM invoices WHERE CAST(tenant_id AS TEXT) = ?',
          tenantId,
        )
      ).rows,
    ).toEqual([]);
    await expect(
      withTenant({ tenantId }, async () =>
        (await TaxSettingsCollection.create({ db })).getOrCreateForTenant(
          tenantId,
        ),
      ),
    ).rejects.toMatchObject({ code: COMMERCE_DATA_NEEDS_UPGRADE });
    expect(await findCommerceMoneyUpgradeNeeds(db)).toMatchObject({
      tenants: expect.arrayContaining([
        { tenantId, reason: 'missing-settings' },
      ]),
    });
    // The scan restores the caller's context afterwards.
    const restored = await db.query(
      "SELECT COALESCE(current_setting('smrt.system_context', true), '') AS value",
    );
    expect(restored.rows[0]?.value).not.toBe('true');
  });

  it('converts a tenant under forced row policies', async () => {
    const tenantId = randomUUID();
    await ensureCommerceTenant(db, tenantId);
    const issued = await oldInvoice(tenantId, true);
    for (const sql of OLD_COLUMNS) await db.query(sql);
    await db.query("UPDATE tax_settings SET money_model = 'v2'");
    await db.query(
      "UPDATE tax_settings SET money_model = 'legacy' WHERE CAST(tenant_id AS TEXT) = ?",
      tenantId,
    );
    for (const table of ['invoices', 'invoice_line_items', 'tax_settings'])
      await systemOnly(db, table);
    await restart();
    const result = await upgradeCommerceMoney(db, { tenantId });
    expect(result.failures).toEqual([]);
    expect(result.upgraded).toMatchObject([{ tenantId, issuedBackfilled: 1 }]);
    const status = await findCommerceMoneyUpgradeNeeds(db);
    expect(status.tenants.map((need) => need.tenantId)).not.toContain(tenantId);
    for (const sql of RESTORE.slice(5)) await db.query(sql);
    const line = (
      await db.query(
        'SELECT amount, tax_amount FROM invoice_line_items WHERE CAST(id AS TEXT) = ?',
        issued.lineId,
      )
    ).rows[0] as Record<string, unknown>;
    expect([Number(line.amount), Number(line.tax_amount)]).toEqual([200, 10]);
  });
});
