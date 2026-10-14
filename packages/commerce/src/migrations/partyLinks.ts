/** Read-only deployment preflight for the Contract party split (#3898). */
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

export interface CommercePartyLinksPreflight {
  purchaseRowsWithCustomer: CommercePartyLinkRow[];
  salesRowsWithVendor: CommercePartyLinkRow[];
  missingRequiredCustomer: CommercePartyLinkRow[];
  missingRequiredVendor: CommercePartyLinkRow[];
  baseTypedRows: CommercePartyLinkRow[];
  discriminatorGroups: CommerceContractTypeGroup[];
  discriminatorMismatches: CommerceContractTypeGroup[];
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

const purchaseTypes = ['purchase_order', 'production_order'] as const;

const leafTypes: Record<string, string> = {
  Estimate: 'estimate',
  Order: 'order',
  WholesaleOrder: 'wholesale_order',
  Cart: 'cart',
  Lease: 'lease',
  Agreement: 'agreement',
  LicenseSale: 'license_sale',
  PurchaseOrder: 'purchase_order',
  ProductionOrder: 'production_order',
};

function inSql(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

function leafMatches(names: readonly string[]): string {
  return names.map((name) => `_meta_type LIKE '%:${name}'`).join(' OR ');
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
    `(${column} IS NULL OR ${column} = '')`;
  const present = (column: 'customer_id' | 'vendor_id') =>
    `(${column} IS NOT NULL AND ${column} <> '')`;
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
    ['PurchaseOrder', 'ProductionOrder'],
  )})`;
  const [
    purchaseRowsWithCustomer,
    salesRowsWithVendor,
    missingRequiredCustomer,
    missingRequiredVendor,
    baseTypedRows,
    grouped,
  ] = await Promise.all([
    rows(`${purchaseSide} AND ${present('customer_id')}`),
    rows(`${salesSide} AND ${present('vendor_id')}`),
    rows(
      `contract_type IN (${inSql([
        'estimate',
        'order',
        'wholesale_order',
        'lease',
        'agreement',
      ])}) AND ${missing('customer_id')}`,
    ),
    rows(`contract_type = 'purchase_order' AND ${missing('vendor_id')}`),
    rows("_meta_type = 'Contract' OR _meta_type LIKE '%:Contract'"),
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
  return {
    purchaseRowsWithCustomer,
    salesRowsWithVendor,
    missingRequiredCustomer,
    missingRequiredVendor,
    baseTypedRows,
    discriminatorGroups,
    discriminatorMismatches,
  };
}
