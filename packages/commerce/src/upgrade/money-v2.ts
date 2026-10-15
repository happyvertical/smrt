/**
 * One-shot upgrade of old-format commerce money data to the current model
 * (#4021).
 *
 * Old-format rows store tax-inclusive line amounts with a fractional
 * `tax_rate` and no `tax_amount`, tax codes or money snapshots. For each
 * tenant {@link findCommerceMoneyUpgradeNeeds} reports, the upgrade:
 *
 * 1. seeds the tenant's tax settings row and standard tax codes;
 * 2. maps each stored rate to a tax code: a zero rate to `exempt` (exempt
 *    customer) or `out-of-scope`, any other rate to a one-component
 *    `rate-<percent>` code it creates once;
 * 3. backfills each issued document from its stored values, without changing
 *    a single stored total: line net, line tax, tax code snapshot, document
 *    taxes and a money snapshot. A document whose stored lines do not add up
 *    exactly to its stored header fails the tenant;
 * 4. recomputes each draft through the runtime from its prices and mapped
 *    codes.
 *
 * Each tenant converts in its own transaction, so one failing tenant leaves
 * the others converted. Once no tenant needs the upgrade, the pre-#4021
 * columns and table are dropped. Nothing records that an upgrade happened.
 *
 * The runtime never imports this module (only `detect.ts`, for its refusal).
 * Delete the `upgrade/` directory, the CLI command and the detection call
 * sites together once no supported version can have written old-format data.
 */

import { isPostgresDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { ContractCollection } from '../collections/ContractCollection.js';
import {
  DocumentTaxCollection,
  type DocumentTaxWriteInput,
} from '../collections/DocumentTaxCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import {
  materializeTenantTaxSettings,
  TaxSettingsCollection,
} from '../collections/TaxSettingsCollection.js';
import {
  DOCUMENT_MONEY_WRITE,
  withDocumentMoneyTransaction,
} from '../document-money-internal.js';
import { deterministicTaxId } from '../tax/identity.js';
import { ensureTenantTaxCodes } from '../tax/standard-codes.js';
import {
  findCommerceMoneyUpgradeNeeds,
  findOldMoneySchema,
  OLD_MONEY_COLUMNS,
  OLD_MONEY_TABLES,
  type TenantMoneyUpgradeNeed,
  withCommerceMoneyUpgradeExecutor,
} from './detect.js';

export interface UpgradeCommerceMoneyOptions {
  /** Convert only this tenant. Omit to convert every tenant that needs it. */
  tenantId?: string;
}

/** One document (or tenant, when `documentId` is empty) the upgrade refused. */
export interface CommerceMoneyUpgradeFailure {
  tenantId: string;
  documentType: 'invoice' | 'contract' | null;
  documentId: string;
  reason: string;
}

export interface CommerceMoneyUpgradeTotals {
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface CommerceMoneyUpgradedTenant {
  tenantId: string;
  issuedBackfilled: number;
  draftsRecomputed: number;
  /** Drafts whose stored totals changed when recomputed. */
  changedDrafts: Array<{
    documentType: 'invoice' | 'contract';
    documentId: string;
    old: CommerceMoneyUpgradeTotals;
    next: CommerceMoneyUpgradeTotals;
  }>;
  /** Rate components created without a tax liability account. */
  componentsWithoutLiabilityAccount: string[];
}

export interface CommerceMoneyUpgradeResult {
  upgraded: CommerceMoneyUpgradedTenant[];
  failures: CommerceMoneyUpgradeFailure[];
  /** Pre-#4021 columns and tables dropped by this run. */
  droppedSchema: string[];
  /** Tenants still needing the upgrade after this run. */
  remaining: TenantMoneyUpgradeNeed[];
}

type Row = Record<string, unknown>;

/** A tenant-level refusal carrying every document failure found. */
class TenantUpgradeRefused extends Error {
  constructor(readonly failures: CommerceMoneyUpgradeFailure[]) {
    super('Commerce money upgrade refused');
  }
}

function rowsOf(result: { rows: unknown[] }): Row[] {
  return result.rows as Row[];
}

function storedNumber(value: unknown, label: string): number {
  const result =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)
          ? Number(value)
          : Number.NaN;
  if (!Number.isFinite(result)) throw new Error(`${label} is not numeric`);
  return result;
}

function storedMinor(value: unknown, label: string): number {
  const result = storedNumber(value ?? 0, label);
  if (!Number.isSafeInteger(result))
    throw new Error(`${label} is not a safe integer minor amount`);
  return result;
}

function roundHalfAwayFromZero(value: number): number {
  const rounded = Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
  if (!Number.isSafeInteger(rounded))
    throw new Error('Line gross exceeds safe integer minor units');
  return rounded;
}

/** Stored net: rounded quantity times unit price, less the flat discount. */
function lineNet(line: Row): number {
  return (
    roundHalfAwayFromZero(
      storedNumber(line.quantity, 'Line quantity') *
        storedMinor(line.unit_price, 'Line unit price'),
    ) - storedMinor(line.discount, 'Line discount')
  );
}

/** A stored fraction (`0.05`) as a canonical percent string (`5`). */
function fractionToPercent(value: unknown): string | null {
  const input = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input)) return null;
  const [whole, fraction = ''] = input.split('.');
  const decimalAt = whole.length + 2;
  const padded = `${whole}${fraction}`.padEnd(decimalAt, '0');
  const head = padded.slice(0, decimalAt).replace(/^0+(?=\d)/, '');
  const tail = padded.slice(decimalAt);
  const result = `${head || '0'}${tail ? `.${tail}` : ''}`
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
  return result || '0';
}

interface MappedCode {
  taxCodeId: string;
  code: string;
  name: string;
  kind: 'taxable' | 'zero-rated' | 'exempt' | 'out-of-scope';
  component: {
    id: string;
    name: string;
    percent: string;
    liabilityAccountId: string | null;
    recoverable: boolean;
  } | null;
}

interface Kind {
  documentType: 'invoice' | 'contract';
  header: 'invoices' | 'contracts';
  lines: 'invoice_line_items' | 'contract_line_items';
  parent: 'invoice_id' | 'contract_id';
}

const KINDS: readonly Kind[] = [
  {
    documentType: 'invoice',
    header: 'invoices',
    lines: 'invoice_line_items',
    parent: 'invoice_id',
  },
  {
    documentType: 'contract',
    header: 'contracts',
    lines: 'contract_line_items',
    parent: 'contract_id',
  },
];

async function tableExists(
  db: DatabaseInterface,
  table: string,
): Promise<boolean> {
  return !db.tableExists || (await db.tableExists(table));
}

async function updateRow(
  db: DatabaseInterface,
  table: string,
  id: string,
  values: Row,
): Promise<void> {
  const entries = Object.entries(values);
  await db.query(
    `UPDATE ${table} SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE CAST(id AS TEXT) = ?`,
    ...entries.map(([, value]) => value),
    id,
  );
}

/** Find or create the tenant's tax code for one stored rate. */
class RateCodes {
  private readonly byKey = new Map<string, MappedCode>();
  readonly componentsWithoutLiabilityAccount: string[] = [];

  constructor(
    private readonly db: DatabaseInterface,
    private readonly tenantId: string,
  ) {}

  async forRate(rate: unknown, customerExempt: boolean): Promise<MappedCode> {
    const percent = fractionToPercent(rate);
    if (percent === null || Number(percent) > 100)
      throw new Error(`stored tax rate ${String(rate)} is not a valid rate`);
    const key =
      percent === '0' ? (customerExempt ? 'exempt' : 'out-of-scope') : percent;
    const cached = this.byKey.get(key);
    if (cached) return cached;
    const codes = await TaxCodeCollection.create({ db: this.db });
    let mapped: MappedCode;
    if (percent === '0') {
      const code = await codes.findByCode(key, this.tenantId);
      if (!code?.id) throw new Error(`standard tax code ${key} is missing`);
      mapped = {
        taxCodeId: code.id,
        code: code.code,
        name: code.name,
        kind: code.kind,
        component: null,
      };
    } else {
      const suffix = percent.replace('.', '_');
      const componentName = `${percent}%`;
      const components = await TaxComponentCollection.create({ db: this.db });
      const componentId = await deterministicTaxId(
        this.tenantId,
        'component',
        `rate-${suffix}`,
      );
      let component = await components.get(
        { id: componentId },
        { cache: false },
      );
      if (!component) {
        component = await components.create({
          id: componentId,
          tenantId: this.tenantId,
          name: componentName,
          percent,
          active: true,
        });
        this.componentsWithoutLiabilityAccount.push(componentId);
      }
      const codeName = `rate-${suffix}`;
      let code = await codes.findByCode(codeName, this.tenantId);
      if (!code)
        code = await codes.create({
          id: await deterministicTaxId(this.tenantId, 'code', codeName),
          tenantId: this.tenantId,
          code: codeName,
          name: componentName,
          kind: 'taxable',
          components: [{ taxComponentId: componentId, compound: false }],
        });
      if (!code.id) throw new Error(`tax code ${codeName} did not persist`);
      mapped = {
        taxCodeId: code.id,
        code: code.code,
        name: code.name,
        kind: code.kind,
        component: {
          id: componentId,
          name: component.name,
          percent: component.percent,
          liabilityAccountId: component.liabilityAccountId || null,
          recoverable: !!component.recoverable,
        },
      };
    }
    this.byKey.set(key, mapped);
    return mapped;
  }
}

async function partyFor(
  db: DatabaseInterface,
  header: Row,
): Promise<{ taxId: string; exempt: boolean }> {
  if (header.customer_id) {
    const row = rowsOf(
      await db.query(
        'SELECT tax_id, tax_exempt FROM customers WHERE CAST(id AS TEXT) = ?',
        String(header.customer_id),
      ),
    )[0];
    return { taxId: String(row?.tax_id ?? ''), exempt: !!row?.tax_exempt };
  }
  if (header.vendor_id) {
    const row = rowsOf(
      await db.query(
        'SELECT tax_id FROM vendors WHERE CAST(id AS TEXT) = ?',
        String(header.vendor_id),
      ),
    )[0];
    return { taxId: String(row?.tax_id ?? ''), exempt: false };
  }
  return { taxId: '', exempt: false };
}

function totalsOf(header: Row): CommerceMoneyUpgradeTotals {
  return {
    subtotalMinor: storedMinor(header.subtotal, 'Header subtotal'),
    taxMinor: storedMinor(header.tax_amount, 'Header tax'),
    totalMinor: storedMinor(header.total_amount, 'Header total'),
  };
}

/**
 * Backfill one issued document from its stored values. Every stored total is
 * kept; the document fails unless its lines reconcile exactly to it.
 */
async function backfillIssued(
  db: DatabaseInterface,
  tenantId: string,
  kind: Kind,
  header: Row,
  lines: Row[],
  codes: RateCodes,
  registrationsJson: string,
): Promise<void> {
  const documentId = String(header.id);
  const party = await partyFor(db, header);
  const stored = totalsOf(header);
  const providerTax =
    kind.documentType === 'invoice'
      ? storedMinor(header.provider_tax_amount, 'Provider tax')
      : 0;
  const snapshotId = crypto.randomUUID();
  const groups = new Map<string, DocumentTaxWriteInput>();
  let netTotal = 0;
  let taxTotal = 0;
  let discountTotal = 0;
  const updates: Array<[string, Row]> = [];
  for (const line of lines) {
    const net = lineNet(line);
    const tax = storedMinor(line.amount, 'Line amount') - net;
    if (tax < 0)
      throw new Error(
        `line ${String(line.id)} stores an amount below its net (${net}), so its tax would be negative`,
      );
    const mapped = await codes.forRate(line.tax_rate, party.exempt);
    if (tax > 0 && !mapped.component)
      throw new Error(
        `line ${String(line.id)} stores tax at a zero rate (${tax} minor units)`,
      );
    netTotal += net;
    taxTotal += tax;
    discountTotal += storedMinor(line.discount, 'Line discount');
    updates.push([
      String(line.id),
      {
        amount: net,
        tax_amount: tax,
        tax_mode: 'override',
        tax_code_id: mapped.taxCodeId,
        tax_code_code: mapped.code,
        tax_code_name: mapped.name,
        tax_components_json: JSON.stringify(
          mapped.component
            ? [
                {
                  taxComponentId: mapped.component.id,
                  name: mapped.component.name,
                  percent: mapped.component.percent,
                  taxMinor: tax,
                },
              ]
            : [],
        ),
        money_snapshot_id: snapshotId,
      },
    ]);
    const key = `${mapped.taxCodeId}\0${mapped.component?.id ?? ''}`;
    const group = groups.get(key);
    if (group) {
      group.taxableMinor += net;
      group.taxMinor += tax;
      if (group.recoverableMinor) group.recoverableMinor += tax;
    } else
      groups.set(key, {
        tenantId,
        documentType: kind.documentType,
        documentId,
        currency: String(header.currency),
        taxCodeId: mapped.taxCodeId,
        taxCodeCode: mapped.code,
        kind: mapped.kind,
        taxComponentId: mapped.component?.id ?? null,
        taxComponentName: mapped.component?.name ?? null,
        percent: mapped.component?.percent ?? null,
        liabilityAccountId: mapped.component?.liabilityAccountId ?? null,
        taxableMinor: net,
        taxMinor: tax,
        recoverableMinor:
          kind.documentType === 'contract' &&
          header.vendor_id &&
          mapped.component?.recoverable
            ? tax
            : 0,
      });
  }
  const mismatches: string[] = [];
  if (netTotal !== stored.subtotalMinor)
    mismatches.push(
      `line net ${netTotal} differs from stored subtotal ${stored.subtotalMinor}`,
    );
  if (taxTotal + providerTax !== stored.taxMinor)
    mismatches.push(
      `line tax ${taxTotal} plus provider tax ${providerTax} differs from stored tax ${stored.taxMinor}`,
    );
  if (stored.subtotalMinor + stored.taxMinor !== stored.totalMinor)
    mismatches.push(
      `stored subtotal ${stored.subtotalMinor} plus tax ${stored.taxMinor} differs from stored total ${stored.totalMinor}`,
    );
  if (mismatches.length > 0)
    throw new Error(`does not reconcile: ${mismatches.join('; ')}`);
  for (const [lineId, values] of updates)
    await updateRow(db, kind.lines, lineId, values);
  await (await DocumentTaxCollection.create({ db })).replaceDerivedForDocument(
    DOCUMENT_MONEY_WRITE,
    {
      tenantId,
      documentType: kind.documentType,
      documentId,
      rows: [...groups.values()],
    },
  );
  // Old-format issued amounts were always tax-exclusive and line-rounded.
  await updateRow(db, kind.header, documentId, {
    discount_total: discountTotal,
    line_amount_type: 'exclusive',
    tax_rounding_scope: 'line',
    seller_tax_registrations_json: registrationsJson,
    party_tax_id: party.taxId,
    money_snapshot_id: snapshotId,
  });
}

/** Point a draft's lines at mapped codes, then recompute it through the runtime. */
async function recomputeDraft(
  db: DatabaseInterface,
  kind: Kind,
  header: Row,
  lines: Row[],
  codes: RateCodes,
): Promise<CommerceMoneyUpgradeTotals> {
  const documentId = String(header.id);
  const party = await partyFor(db, header);
  for (const line of lines) {
    const mapped = await codes.forRate(line.tax_rate, party.exempt);
    await updateRow(db, kind.lines, String(line.id), {
      tax_mode: 'override',
      tax_code_id: mapped.taxCodeId,
    });
  }
  await updateRow(db, kind.header, documentId, {
    line_amount_type: 'exclusive',
    tax_rounding_scope: 'line',
  });
  const document =
    kind.documentType === 'invoice'
      ? await (await InvoiceCollection.create({ db })).get(
          { id: documentId },
          { cache: false },
        )
      : await (await ContractCollection.create({ db })).get(
          { id: documentId },
          { cache: false },
        );
  if (!document) throw new Error('draft disappeared during the upgrade');
  await document.save();
  return {
    subtotalMinor: document.subtotal,
    taxMinor: document.taxAmount,
    totalMinor: document.totalAmount,
  };
}

function isIssued(kind: Kind, header: Row): boolean {
  return (
    String(header.status ?? 'draft') !== 'draft' ||
    (kind.documentType === 'invoice' && !!header.ar_journal_id)
  );
}

/** Convert one tenant on `tx`; throws {@link TenantUpgradeRefused} on any failure. */
async function convertTenant(
  tx: DatabaseInterface,
  tenantId: string,
  oldSchema: readonly string[],
): Promise<CommerceMoneyUpgradedTenant> {
  await materializeTenantTaxSettings(tx, tenantId);
  await ensureTenantTaxCodes(tx, tenantId);
  const settings = await (
    await TaxSettingsCollection.create({ db: tx })
  ).getForTenant(tenantId);
  if (!settings) throw new Error('Tenant tax settings did not persist');
  const codes = new RateCodes(tx, tenantId);
  const failures: CommerceMoneyUpgradeFailure[] = [];
  const result: CommerceMoneyUpgradedTenant = {
    tenantId,
    issuedBackfilled: 0,
    draftsRecomputed: 0,
    changedDrafts: [],
    componentsWithoutLiabilityAccount: codes.componentsWithoutLiabilityAccount,
  };
  const drafts: Array<{ kind: Kind; header: Row; lines: Row[] }> = [];
  for (const kind of KINDS) {
    if (!(await tableExists(tx, kind.header))) continue;
    const headers = rowsOf(
      await tx.query(
        `SELECT * FROM ${kind.header} WHERE CAST(tenant_id AS TEXT) = ? ORDER BY id`,
        tenantId,
      ),
    );
    for (const header of headers) {
      const documentId = String(header.id);
      const lines = rowsOf(
        await tx.query(
          `SELECT * FROM ${kind.lines} WHERE CAST(${kind.parent} AS TEXT) = ? ORDER BY id`,
          documentId,
        ),
      );
      try {
        const foreign = lines.find(
          (line) => String(line.tenant_id ?? '') !== tenantId,
        );
        if (foreign)
          throw new Error(
            `line ${String(foreign.id)} belongs to another tenant`,
          );
        if (isIssued(kind, header)) {
          if (header.money_snapshot_id) continue;
          await backfillIssued(
            tx,
            tenantId,
            kind,
            header,
            lines,
            codes,
            settings.taxRegistrationsJson,
          );
          result.issuedBackfilled++;
        } else drafts.push({ kind, header, lines });
      } catch (error) {
        failures.push({
          tenantId,
          documentType: kind.documentType,
          documentId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  if (failures.length > 0) throw new TenantUpgradeRefused(failures);
  if (oldSchema.includes('tax_settings.money_model'))
    await tx.query(
      `UPDATE tax_settings SET money_model = 'v2'${
        oldSchema.includes('tax_settings.money_migration_id')
          ? ", money_migration_id = ''"
          : ''
      } WHERE CAST(tenant_id AS TEXT) = ?`,
      tenantId,
    );
  for (const { kind, header, lines } of drafts) {
    const old = totalsOf(header);
    try {
      const next = await recomputeDraft(tx, kind, header, lines, codes);
      result.draftsRecomputed++;
      if (
        next.subtotalMinor !== old.subtotalMinor ||
        next.taxMinor !== old.taxMinor ||
        next.totalMinor !== old.totalMinor
      )
        result.changedDrafts.push({
          documentType: kind.documentType,
          documentId: String(header.id),
          old,
          next,
        });
    } catch (error) {
      failures.push({
        tenantId,
        documentType: kind.documentType,
        documentId: String(header.id),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failures.length > 0) throw new TenantUpgradeRefused(failures);
  return result;
}

async function dropOldSchema(
  db: DatabaseInterface,
  oldSchema: readonly string[],
): Promise<string[]> {
  const dropped: string[] = [];
  const postgres = isPostgresDatabase(db);
  await withDocumentMoneyTransaction(db, async (tx) => {
    for (const [table, column] of OLD_MONEY_COLUMNS) {
      if (!oldSchema.includes(`${table}.${column}`)) continue;
      await tx.query(
        postgres
          ? `ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column}`
          : `ALTER TABLE ${table} DROP COLUMN ${column}`,
      );
      dropped.push(`${table}.${column}`);
    }
    for (const table of OLD_MONEY_TABLES) {
      if (!oldSchema.includes(table)) continue;
      await tx.query(`DROP TABLE IF EXISTS ${table}`);
      dropped.push(table);
    }
  });
  return dropped.sort();
}

/**
 * Convert old-format commerce money data to the current model. Safe to rerun:
 * a converted tenant is no longer reported, and a failed tenant changed
 * nothing. Read `failures` and `remaining`; the CLI exits nonzero on either.
 */
export async function upgradeCommerceMoney(
  db: DatabaseInterface,
  options: UpgradeCommerceMoneyOptions = {},
): Promise<CommerceMoneyUpgradeResult> {
  if (!db.transaction)
    throw new Error('The commerce money upgrade requires transactions');
  const before = await findCommerceMoneyUpgradeNeeds(db);
  const targets = before.tenants.filter(
    (need) => !options.tenantId || need.tenantId === options.tenantId,
  );
  const upgraded: CommerceMoneyUpgradedTenant[] = [];
  const failures: CommerceMoneyUpgradeFailure[] = [];
  for (const need of targets) {
    if (need.reason === 'interrupted-migration') {
      failures.push({
        tenantId: need.tenantId,
        documentType: null,
        documentId: '',
        reason:
          'A tenant migration from an earlier version never finished. Roll it back with the version that started it, or reset the tenant data.',
      });
      continue;
    }
    try {
      upgraded.push(
        await withDocumentMoneyTransaction(db, (tx) =>
          withCommerceMoneyUpgradeExecutor(tx, () =>
            withTenant({ tenantId: need.tenantId }, () =>
              convertTenant(tx, need.tenantId, before.oldSchema),
            ),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof TenantUpgradeRefused)
        failures.push(...error.failures);
      else
        failures.push({
          tenantId: need.tenantId,
          documentType: null,
          documentId: '',
          reason: error instanceof Error ? error.message : String(error),
        });
    }
  }
  const after = await findCommerceMoneyUpgradeNeeds(db);
  const droppedSchema =
    after.tenants.length === 0 && after.oldSchema.length > 0
      ? await dropOldSchema(db, after.oldSchema)
      : [];
  if (droppedSchema.length > 0 && (await findOldMoneySchema(db)).length > 0)
    throw new Error('The pre-upgrade commerce money schema was not removed');
  return { upgraded, failures, droppedSchema, remaining: after.tenants };
}
