import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import type { TaxCode } from '../models/TaxCode.js';

export interface LegacyTaxMapReport {
  tenantId: string;
  createdComponents: number;
  createdCodes: number;
  missingLiabilityAccountComponentIds: string[];
  /** Every legacy source rate and the durable tax code selected for it. */
  mappings: Array<{
    sourceRate: string;
    taxCodeId: string;
    taxComponentId: string | null;
  }>;
  /** Invalid legacy rates are retained through `legacy-unreconciled`. */
  unreconciledRates: string[];
}

export interface MapLegacyTaxRatesOptions {
  /** Limit a resumable migration to one tenant. Omit only for a system admin run. */
  tenantId?: string;
}

export interface LegacyTaxRateRow {
  tenantId?: string;
  tenant_id?: string;
  taxRate?: unknown;
  tax_rate?: unknown;
  customerTaxExempt?: unknown;
  customer_tax_exempt?: unknown;
}

function tenantIdOf(row: LegacyTaxRateRow): string {
  return String(row.tenantId ?? row.tenant_id ?? '');
}

function taxRateOf(row: LegacyTaxRateRow): unknown {
  return row.taxRate ?? row.tax_rate;
}

function customerExemptOf(row: LegacyTaxRateRow): boolean {
  return Boolean(row.customerTaxExempt ?? row.customer_tax_exempt);
}

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

async function tenantCodes(db: DatabaseInterface): Promise<TaxCodeCollection> {
  return TaxCodeCollection.create({ db });
}

/**
 * Ensure the three non-taxable codes every tenant needs. Repeating the call is
 * safe; callers must use a transaction-capable database so the check/create
 * sequence is atomic with their surrounding migration.
 */
export async function ensureTenantTaxCodes(
  db: DatabaseInterface,
  tenantId: string,
): Promise<TaxCode[]> {
  return withTenant({ tenantId }, async () => {
    const codes = await tenantCodes(db);
    const result: TaxCode[] = [];
    for (const [code, name, kind] of [
      ['exempt', 'Exempt', 'exempt'],
      ['zero-rated', 'Zero rated', 'zero-rated'],
      ['out-of-scope', 'Out of scope', 'out-of-scope'],
      [
        'legacy-unreconciled',
        'Legacy rate requires reconciliation',
        'out-of-scope',
      ],
    ] as const) {
      const existing = await codes.findByCode(code);
      if (existing) result.push(existing);
      else result.push(await codes.create({ tenantId, code, name, kind }));
    }
    return result;
  });
}

async function rateRows(
  db: DatabaseInterface,
  tenantId: string,
): Promise<LegacyTaxRateRow[]> {
  const sql = `
    SELECT i.tenant_id AS "tenantId", li.tax_rate AS "taxRate",
      CASE WHEN c.tax_exempt THEN TRUE ELSE FALSE END AS "customerTaxExempt"
    FROM invoice_line_items li
    JOIN invoices i ON i.id = li.invoice_id
    LEFT JOIN customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id
    WHERE i.tenant_id = ?
    UNION ALL
    SELECT c.tenant_id AS "tenantId", li.tax_rate AS "taxRate",
      CASE WHEN customer.tax_exempt THEN TRUE ELSE FALSE END AS "customerTaxExempt"
    FROM contract_line_items li
    JOIN contracts c ON c.id = li.contract_id
    LEFT JOIN customers customer ON customer.id = c.customer_id AND customer.tenant_id = c.tenant_id
    WHERE c.tenant_id = ?`;
  const result = await db.query(sql, tenantId, tenantId);
  return result.rows as LegacyTaxRateRow[];
}

async function sourceTenantIds(db: DatabaseInterface): Promise<string[]> {
  const result = await db.query(`
    SELECT DISTINCT tenant_id AS "tenantId" FROM invoices WHERE tenant_id IS NOT NULL
    UNION
    SELECT DISTINCT tenant_id AS "tenantId" FROM contracts WHERE tenant_id IS NOT NULL`);
  return (result.rows as LegacyTaxRateRow[])
    .map(tenantIdOf)
    .filter(Boolean)
    .sort();
}

/**
 * Map old fractional line tax rates to rate components and one-component tax
 * codes. A historical zero means no tax was applied, therefore it maps to
 * out-of-scope unless the linked customer was explicitly exempt.
 */
export async function mapLegacyTaxRates(
  db: DatabaseInterface,
  options: MapLegacyTaxRatesOptions = {},
): Promise<LegacyTaxMapReport[]> {
  if (!db.transaction)
    throw new Error(
      'Legacy tax mapping requires database transaction support.',
    );
  const tenantIds = options.tenantId
    ? [options.tenantId]
    : await sourceTenantIds(db);
  const reports: LegacyTaxMapReport[] = [];
  for (const tenantId of tenantIds) {
    const tenantRows = await rateRows(db, tenantId);
    reports.push(
      await db.transaction((tx) =>
        mapLegacyTaxRatesInTransaction(tx, tenantId, tenantRows),
      ),
    );
  }
  return reports;
}

/**
 * Executor-affine mapping entry point for a caller that already owns an open
 * transaction. It never opens or commits a nested transaction. `tenantRows`
 * are supplied by the wrapper after its source read so each tenant remains
 * isolated and a failed mapping rolls back as one unit.
 */
export async function mapLegacyTaxRatesInTransaction(
  tx: DatabaseInterface,
  tenantId: string,
  tenantRows: readonly LegacyTaxRateRow[],
): Promise<LegacyTaxMapReport> {
  return withTenant({ tenantId }, async () => {
    const codes = await tenantCodes(tx);
    const components = await TaxComponentCollection.create({ db: tx });
    const seeded = await ensureTenantTaxCodes(tx, tenantId);
    const byCode = new Map(seeded.map((code) => [code.code, code]));
    let createdComponents = 0;
    let createdCodes = 0;
    const missingLiabilityAccountComponentIds: string[] = [];
    const mappings: LegacyTaxMapReport['mappings'] = [];
    const unreconciledRates: string[] = [];
    for (const row of tenantRows) {
      const percent = fractionToPercent(taxRateOf(row));
      if (percent === null || Number(percent) > 100) {
        const code = byCode.get('legacy-unreconciled');
        if (!code?.id) throw new Error('Expected tenant unreconciled code.');
        const sourceRate = String(taxRateOf(row) ?? '');
        unreconciledRates.push(sourceRate);
        mappings.push({
          sourceRate,
          taxCodeId: code.id,
          taxComponentId: null,
        });
        continue;
      }
      if (percent === '0') {
        const code = customerExemptOf(row)
          ? byCode.get('exempt')
          : byCode.get('out-of-scope');
        if (!code?.id) throw new Error('Expected tenant non-taxable codes.');
        mappings.push({
          sourceRate: String(taxRateOf(row) ?? ''),
          taxCodeId: code.id,
          taxComponentId: null,
        });
        continue;
      }
      const suffix = percent.replace('.', '_');
      const componentName = `Legacy ${percent}%`;
      let component = (
        await components.list({ where: { name: componentName }, limit: 1 })
      )[0];
      if (!component) {
        component = await components.create({
          tenantId,
          name: componentName,
          percent,
          active: true,
        });
        createdComponents++;
        if (!component.id) throw new Error('Saved tax component has no ID.');
        missingLiabilityAccountComponentIds.push(component.id);
      }
      const codeName = `legacy-${suffix}`;
      let code = await codes.findByCode(codeName);
      if (!code) {
        if (!component.id) throw new Error('Saved tax component has no ID.');
        code = await codes.create({
          tenantId,
          code: codeName,
          name: `Legacy ${percent}%`,
          kind: 'taxable',
          components: [{ taxComponentId: component.id, compound: false }],
        });
        createdCodes++;
      }
      if (!code.id || !component.id)
        throw new Error('Expected saved tax mapping.');
      mappings.push({
        sourceRate: String(taxRateOf(row) ?? ''),
        taxCodeId: code.id,
        taxComponentId: component.id,
      });
    }
    return {
      tenantId,
      createdComponents,
      createdCodes,
      missingLiabilityAccountComponentIds,
      mappings,
      unreconciledRates,
    };
  });
}
