import {
  ObjectRegistry,
  type SmrtObject,
  type SmrtObjectOptions,
} from '@happyvertical/smrt-core';
import { CampaignCustomerScopeError } from './errors.js';

const CUSTOMER_QUALIFIED_NAME = '@happyvertical/smrt-commerce:Customer';
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

interface QueryResult {
  rows: Array<Record<string, unknown>>;
}

interface QueryDatabase {
  query(sql: string, ...params: unknown[]): Promise<QueryResult>;
}

interface DatabaseOptions {
  db?: SmrtObjectOptions['db'];
}

function requireDatabase(options: DatabaseOptions): QueryDatabase {
  const db = options.db;
  if (!db || typeof db !== 'object' || !('query' in db)) {
    throw new Error(
      'Campaign customer queries require an initialized database connection.',
    );
  }
  return db as QueryDatabase;
}

async function resolveCustomerTable(options: DatabaseOptions): Promise<string> {
  await ObjectRegistry.ensureManifestLoaded(CUSTOMER_QUALIFIED_NAME);
  const target =
    ObjectRegistry.getClassByQualifiedName(CUSTOMER_QUALIFIED_NAME) ??
    ObjectRegistry.getClass(CUSTOMER_QUALIFIED_NAME);
  if (!target) {
    throw new Error(
      'Campaign customer queries require @happyvertical/smrt-commerce:Customer to be registered.',
    );
  }

  const probe = new target.constructor(options) as SmrtObject;
  const tableName = probe.tableName;
  if (!SAFE_SQL_IDENTIFIER.test(tableName)) {
    throw new Error('Campaign customer table has an invalid identifier.');
  }
  return tableName;
}

/**
 * Verify a bounded set of canonical commerce Customers in one database read.
 * The generic failure deliberately does not reveal whether an id is missing or
 * belongs to another tenant.
 */
export async function assertCustomersBelongToTenant(
  options: DatabaseOptions,
  tenantId: string | null,
  customerIds: readonly string[],
  label: string,
): Promise<void> {
  if (customerIds.length === 0) return;
  const db = requireDatabase(options);
  const tableName = await resolveCustomerTable(options);
  const placeholders = customerIds.map(() => '?').join(', ');
  const result = await db.query(
    `SELECT id, tenant_id FROM ${tableName} WHERE id IN (${placeholders})`,
    ...customerIds,
  );
  const tenantById = new Map(
    result.rows.map((row) => [String(row.id), row.tenant_id ?? null]),
  );
  const valid = customerIds.every(
    (customerId) =>
      tenantById.has(customerId) && tenantById.get(customerId) === tenantId,
  );
  if (!valid) {
    throw new CampaignCustomerScopeError(label);
  }
}
