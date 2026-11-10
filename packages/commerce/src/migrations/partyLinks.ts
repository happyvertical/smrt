/** Read-only deployment preflight for the Contract party split (#3898). */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';

export interface CommercePartyLinkRow {
  id: string;
  tenant_id: string | null;
  _meta_type: string | null;
  contract_type: string | null;
  customer_id: string | null;
  vendor_id: string | null;
}

export interface CommerceContractTypeGroup {
  _meta_type: string | null;
  contract_type: string | null;
  count: number;
}

/** Existing document whose contract link will fail branch validation on save. */
export interface CommerceInvalidContractReference {
  source_table: string;
  source_id: string;
  source_tenant_id: string | null;
  contract_id: string;
  contract_meta_type: string | null;
  contract_tenant_id: string | null;
}

export interface CommercePartyLinksPreflight {
  purchaseRowsWithCustomer: CommercePartyLinkRow[];
  salesRowsWithVendor: CommercePartyLinkRow[];
  missingRequiredCustomer: CommercePartyLinkRow[];
  missingRequiredVendor: CommercePartyLinkRow[];
  baseTypedRows: CommercePartyLinkRow[];
  unqualifiedDiscriminatorRows: CommercePartyLinkRow[];
  discriminatorGroups: CommerceContractTypeGroup[];
  discriminatorMismatches: CommerceContractTypeGroup[];
  invalidSalesReferences: CommerceInvalidContractReference[];
  invalidPurchaseReferences: CommerceInvalidContractReference[];
}

const COLUMNS =
  'id, tenant_id, _meta_type, contract_type, customer_id, vendor_id';

const salesTypes = [
  'estimate',
  'order',
  'wholesale_order',
  'cart',
  'lease',
  'agreement',
  'license_sale',
] as const;

const purchaseTypes = [
  'supplier_quote',
  'purchase_order',
  'production_order',
] as const;

const leafTypes: Record<string, string> = {
  Estimate: 'estimate',
  Order: 'order',
  WholesaleOrder: 'wholesale_order',
  Cart: 'cart',
  Lease: 'lease',
  Agreement: 'agreement',
  LicenseSale: 'license_sale',
  SupplierQuote: 'supplier_quote',
  PurchaseOrder: 'purchase_order',
  ProductionOrder: 'production_order',
};

function inSql(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

function leafMatches(names: readonly string[], column = '_meta_type'): string {
  return names
    .map((name) => `(${column} = '${name}' OR ${column} LIKE '%:${name}')`)
    .join(' OR ');
}

/** Inspect existing party links before deploying the new STI hierarchy. Never writes. */
export async function preflightCommercePartyLinks(
  db: DatabaseInterface,
): Promise<CommercePartyLinksPreflight> {
  const rows = async (where: string): Promise<CommercePartyLinkRow[]> => {
    const result = await db.query(
      `SELECT ${COLUMNS} FROM contracts WHERE ${where}`,
    );
    return result.rows as CommercePartyLinkRow[];
  };
  const missing = (column: 'customer_id' | 'vendor_id') =>
    `(${column} IS NULL OR CAST(${column} AS TEXT) = '')`;
  const present = (column: 'customer_id' | 'vendor_id') =>
    `(${column} IS NOT NULL AND CAST(${column} AS TEXT) <> '')`;
  const knownLeaf = leafMatches(Object.keys(leafTypes));
  const fallbackType = `(_meta_type IS NULL OR NOT (${knownLeaf}))`;
  const salesSide = `(contract_type IN (${inSql(salesTypes)}) OR ${leafMatches([
    'Estimate',
    'Order',
    'WholesaleOrder',
    'Cart',
    'Lease',
    'Agreement',
    'LicenseSale',
  ])})`;
  const purchaseSide = `(contract_type IN (${inSql(purchaseTypes)}) OR ${leafMatches(
    ['SupplierQuote', 'PurchaseOrder', 'ProductionOrder'],
  )})`;
  const [
    purchaseRowsWithCustomer,
    salesRowsWithVendor,
    missingRequiredCustomer,
    missingRequiredVendor,
    baseTypedRows,
    unqualifiedDiscriminatorRows,
    grouped,
  ] = await Promise.all([
    rows(`${purchaseSide} AND ${present('customer_id')}`),
    rows(`${salesSide} AND ${present('vendor_id')}`),
    rows(
      `(${leafMatches([
        'Estimate',
        'Order',
        'WholesaleOrder',
        'Lease',
        'Agreement',
      ])} OR (${fallbackType} AND contract_type IN (${inSql([
        'estimate',
        'order',
        'wholesale_order',
        'lease',
        'agreement',
      ])}))) AND ${missing('customer_id')}`,
    ),
    rows(
      `(${leafMatches(['SupplierQuote', 'PurchaseOrder'])} OR (${fallbackType} AND contract_type IN ('supplier_quote', 'purchase_order'))) AND ${missing('vendor_id')}`,
    ),
    rows("_meta_type = 'Contract' OR _meta_type LIKE '%:Contract'"),
    rows("_meta_type IS NOT NULL AND _meta_type NOT LIKE '%:%'"),
    db.query(
      'SELECT _meta_type, contract_type, COUNT(*) AS n FROM contracts GROUP BY _meta_type, contract_type ORDER BY n DESC',
    ),
  ]);
  const discriminatorGroups = (
    grouped.rows as Array<{
      _meta_type: string | null;
      contract_type: string | null;
      n: number | string | bigint;
    }>
  ).map((row) => ({
    _meta_type: row._meta_type,
    contract_type: row.contract_type,
    count: Number(row.n),
  }));
  const discriminatorMismatches = discriminatorGroups.filter((group) => {
    const leaf = group._meta_type?.split(':').at(-1);
    return leaf && leafTypes[leaf] && leafTypes[leaf] !== group.contract_type;
  });
  const invalidReferences = async (
    table: string,
    column: 'contract_id' | 'commitment_id',
    allowed: readonly string[],
    branch: 'SalesContract' | 'PurchaseContract',
  ): Promise<CommerceInvalidContractReference[]> => {
    if (!(await db.tableExists(table))) return [];
    const descendants = ObjectRegistry.getDescendants(
      `@happyvertical/smrt-commerce:${branch}`,
    ).filter((name) => ObjectRegistry.getTableStrategy(name) === 'sti');
    const registeredMatch = descendants.length
      ? ` OR contract._meta_type IN (${descendants.map(() => '?').join(', ')})`
      : '';
    const result = await db.query(
      `SELECT '${table}' AS source_table, source.id AS source_id,
              source.tenant_id AS source_tenant_id,
              CAST(source.${column} AS TEXT) AS contract_id,
              contract._meta_type AS contract_meta_type,
              contract.tenant_id AS contract_tenant_id
         FROM ${table} source
         LEFT JOIN contracts contract
           ON CAST(source.${column} AS TEXT) = CAST(contract.id AS TEXT)
        WHERE source.${column} IS NOT NULL
          AND CAST(source.${column} AS TEXT) <> ''
          AND (contract.id IS NULL OR contract._meta_type IS NULL
               OR NOT (${leafMatches(allowed, 'contract._meta_type')}${registeredMatch})
               OR (source.tenant_id IS NOT NULL
                   AND CAST(source.tenant_id AS TEXT) <> ''
                   AND (contract.tenant_id IS NULL
                        OR CAST(source.tenant_id AS TEXT) <> CAST(contract.tenant_id AS TEXT))))`,
      ...descendants,
    );
    return result.rows as CommerceInvalidContractReference[];
  };
  const invalidSalesReferences = (
    await Promise.all(
      ['invoices', 'payments', 'fulfillments', 'ad_groups'].map((table) =>
        invalidReferences(
          table,
          'contract_id',
          [
            'Estimate',
            'Order',
            'WholesaleOrder',
            'Cart',
            'Lease',
            'Agreement',
            'LicenseSale',
          ],
          'SalesContract',
        ),
      ),
    )
  ).flat();
  const invalidPurchaseReferences = await invalidReferences(
    'expenses',
    'commitment_id',
    ['SupplierQuote', 'PurchaseOrder', 'ProductionOrder'],
    'PurchaseContract',
  );
  return {
    purchaseRowsWithCustomer,
    salesRowsWithVendor,
    missingRequiredCustomer,
    missingRequiredVendor,
    baseTypedRows,
    unqualifiedDiscriminatorRows,
    discriminatorGroups,
    discriminatorMismatches,
    invalidSalesReferences,
    invalidPurchaseReferences,
  };
}
