/** Internal capabilities shared by commerce document-money persistence. */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { MoneyValidationError } from './money.js';

/**
 * Capability required by derived money rows. This module is intentionally not
 * exported from the package root; aggregate persistence owns every mutation.
 */
export const DOCUMENT_MONEY_WRITE = Symbol('commerce.documentMoneyWrite');

export type DocumentMoneyWriteCapability = typeof DOCUMENT_MONEY_WRITE;

export interface MoneyParentLockCollection {
  readonly tableName: string;
  query(
    sql: string,
    params: unknown[],
    options: { allowRawOnTenantScoped: true },
  ): Promise<unknown[]>;
}
export interface MoneyParentLockTarget {
  id: string;
  tenantId: string;
  collection: MoneyParentLockCollection;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `Unsafe money parent table identifier: ${identifier}`,
    );
  }
  return `"${identifier}"`;
}

function assertIdentifier(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${label} must be a nonempty identifier`,
    );
  }
}
/** Run aggregate work on one transaction-bound database executor. */
export async function withDocumentMoneyTransaction<T>(
  db: DatabaseInterface,
  operation: (tx: DatabaseInterface) => Promise<T>,
): Promise<T> {
  if (!db.transaction) {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Document money persistence requires transaction support',
    );
  }
  return db.transaction(operation);
}

/**
 * Serialize aggregate writers by touching each tenant-owned parent first.
 * Parents are locked sequentially in stable code-unit ID order. Callers must
 * re-read authoritative parent and child state on the same executor afterward.
 */
export async function lockDocumentMoneyParents(
  targets: readonly MoneyParentLockTarget[],
): Promise<void> {
  const sorted = [...targets].sort(
    (left, right) =>
      compareCodeUnits(left.id, right.id) ||
      compareCodeUnits(left.collection.tableName, right.collection.tableName),
  );
  const identities = new Set<string>();
  for (const target of sorted) {
    assertIdentifier(target.id, 'Money parent id');
    assertIdentifier(target.tenantId, 'Money parent tenant id');
    const identity = `${target.collection.tableName}\u0000${target.id}`;
    if (identities.has(identity)) {
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        `Duplicate money parent lock target: ${target.id}`,
      );
    }
    identities.add(identity);
    const table = quoteIdentifier(target.collection.tableName);
    const locked = await target.collection.query(
      `UPDATE ${table}
          SET "updated_at" = "updated_at"
        WHERE "id" = ? AND "tenant_id" = ?
        RETURNING "id"`,
      [target.id, target.tenantId],
      { allowRawOnTenantScoped: true },
    );
    if (locked.length !== 1) {
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        `Money parent ${target.id} was not found in tenant ${target.tenantId}`,
      );
    }
  }
}
