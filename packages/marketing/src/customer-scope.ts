import {
  ObjectRegistry,
  type SmrtObject,
  type SmrtObjectOptions,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { CampaignCustomerScopeError } from './errors.js';

const CUSTOMER_QUALIFIED_NAME = '@happyvertical/smrt-commerce:Customer';
const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type QueryDatabase = Pick<DatabaseInterface, 'query' | 'url'>;

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
  lock: 'none' | 'share' | 'update' = 'none',
): Promise<void> {
  if (customerIds.length === 0) return;
  const normalizedCustomerIds = customerIds.map((customerId) => {
    try {
      return normalizeUuid(customerId, 'customerId');
    } catch {
      throw new CampaignCustomerScopeError(label);
    }
  });
  const normalizedTenantId = tenantId?.toLowerCase() ?? null;
  const db = requireDatabase(options);
  const tableName = await resolveCustomerTable(options);
  const placeholders = normalizedCustomerIds.map(() => '?').join(', ');
  const lockClause = postgresLockClause(db, lock);
  const result = await db.query(
    `SELECT id, tenant_id FROM ${tableName} WHERE id IN (${placeholders})${lockClause}`,
    ...normalizedCustomerIds,
  );
  const tenantById = new Map(
    result.rows.map((row) => [
      String(row.id).toLowerCase(),
      row.tenant_id == null ? null : String(row.tenant_id).toLowerCase(),
    ]),
  );
  const valid = normalizedCustomerIds.every(
    (customerId) =>
      tenantById.has(customerId) &&
      tenantById.get(customerId) === normalizedTenantId,
  );
  if (!valid) {
    throw new CampaignCustomerScopeError(label);
  }
}

function postgresLockClause(
  db: QueryDatabase,
  lock: 'none' | 'share' | 'update',
): string {
  if (lock === 'none' || !/^postgres(?:ql)?:/iu.test(db.url)) return '';
  return lock === 'update' ? ' FOR UPDATE' : ' FOR SHARE';
}

/** Parse and canonicalize one UUID without echoing the rejected value. */
export function normalizeUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a canonical UUID.`);
  }
  return value.toLowerCase();
}
