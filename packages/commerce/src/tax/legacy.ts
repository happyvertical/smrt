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
    ] as const) {
      const existing = await codes.findByCode(code);
      if (existing) result.push(existing);
      else result.push(await codes.create({ tenantId, code, name, kind }));
    }
    return result;
  });
}

async function rateRows(db: DatabaseInterface): Promise<LegacyTaxRateRow[]> {
  const sql = `
    SELECT i.tenant_id AS "tenantId", li.tax_rate AS "taxRate",
      COALESCE(c.tax_exempt, 0) AS "customerTaxExempt"
    FROM invoice_line_items li
    JOIN invoices i ON i.id = li.invoice_id
    LEFT JOIN customers c ON c.id = i.customer_id
    UNION ALL
    SELECT c.tenant_id AS "tenantId", li.tax_rate AS "taxRate",
      COALESCE(customer.tax_exempt, 0) AS "customerTaxExempt"
    FROM contract_line_items li
    JOIN contracts c ON c.id = li.contract_id
    LEFT JOIN customers customer ON customer.id = c.customer_id`;
  const result = await db.query(sql);
  return result.rows as LegacyTaxRateRow[];
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
  const rows = await rateRows(db);
  const byTenant = new Map<string, LegacyTaxRateRow[]>();
  for (const row of rows) {
    const tenantId = tenantIdOf(row);
    if (!tenantId || (options.tenantId && tenantId !== options.tenantId))
      continue;
    const bucket = byTenant.get(tenantId) ?? [];
    bucket.push(row);
    byTenant.set(tenantId, bucket);
  }
  const reports: LegacyTaxMapReport[] = [];
  for (const [tenantId, tenantRows] of byTenant) {
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
    for (const row of tenantRows) {
      const percent = fractionToPercent(taxRateOf(row));
      if (percent === null) continue;
      if (percent === '0') {
        const code = customerExemptOf(row)
          ? byCode.get('exempt')
          : byCode.get('out-of-scope');
        if (!code) throw new Error('Expected tenant non-taxable codes.');
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
      if (!(await codes.findByCode(codeName))) {
        if (!component.id) throw new Error('Saved tax component has no ID.');
        await codes.create({
          tenantId,
          code: codeName,
          name: `Legacy ${percent}%`,
          kind: 'taxable',
          components: [{ taxComponentId: component.id, compound: false }],
        });
        createdCodes++;
      }
    }
    return {
      tenantId,
      createdComponents,
      createdCodes,
      missingLiabilityAccountComponentIds,
    };
  });
}
