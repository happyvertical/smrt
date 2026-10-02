/**
 * Small, pure validators shared by the expense models.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { ExpenseError, type ExpenseErrorCode } from './types.js';

/** Lowercase kebab-case: `material`, `outside-service`. */
export const CATEGORY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ISO_CURRENCY = /^[A-Z]{3}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const QUALIFIED_CLASS = /^[^\s:]+:[A-Za-z_$][\w$]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Throw unless `value` is a non-negative, JavaScript-safe integer number of
 * minor units. Money is exact: `$19.99` is `1999`, never `19.99`.
 */
export function assertMinorUnits(
  model: string,
  label: string,
  fieldName: string,
  value: number,
  code: ExpenseErrorCode = 'EXPENSE_INVALID',
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExpenseError(
      code,
      `${model} ${label}: ${fieldName} must be a non-negative integer ` +
        `number of minor units (cents) — got ${value}. $19.99 is 1999.`,
    );
  }
}

/** Throw unless `value` is an upper-case ISO 4217 code such as `USD`. */
export function assertIsoCurrency(
  model: string,
  label: string,
  value: string,
): void {
  if (!ISO_CURRENCY.test(value)) {
    throw new ExpenseError(
      'EXPENSE_INVALID',
      `${model} ${label}: currency must be a three-letter ISO 4217 code ` +
        `(for example 'USD'), got '${value}'.`,
    );
  }
}

/** Throw unless `value` is a real calendar date written `YYYY-MM-DD`. */
export function assertIsoDate(
  model: string,
  label: string,
  fieldName: string,
  value: string,
): void {
  const match = ISO_DATE.exec(value);
  const valid =
    match !== null &&
    (() => {
      const [year, month, day] = match.slice(1).map(Number);
      const date = new Date(Date.UTC(year, month - 1, day));
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    })();
  if (!valid) {
    throw new ExpenseError(
      'EXPENSE_INVALID',
      `${model} ${label}: ${fieldName} must be a calendar date written ` +
        `YYYY-MM-DD, got '${value}'.`,
    );
  }
}

/**
 * Throw unless `value` is a package-qualified class name such as
 * `@happyvertical/smrt-projects:Project`. A bare class name is ambiguous
 * (packages can share names) and is refused.
 */
export function assertQualifiedClassName(
  model: string,
  label: string,
  value: string,
): void {
  if (!QUALIFIED_CLASS.test(value)) {
    throw new ExpenseError(
      'EXPENSE_INVALID',
      `${model} ${label}: costObjectType must be a qualified class name ` +
        `such as '@happyvertical/smrt-projects:Project', got '${value}'.`,
    );
  }
}

/** Normalize and check a SHA-256 hex digest; returns it in lower case. */
export function normalizeSha256(model: string, label: string, value: string) {
  const digest = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!SHA256_HEX.test(digest)) {
    throw new ExpenseError(
      'EXPENSE_RECEIPT_INVALID',
      `${model} ${label}: contentSha256 must be a 64-character hex SHA-256 ` +
        'digest of the file bytes.',
    );
  }
  return digest;
}

/**
 * Lowercase hex SHA-256 of a file's bytes — the value
 * `ExpenseReceipt.contentSha256` expects.
 *
 * @example
 * ```typescript
 * const digest = computeContentSha256(await readFile('receipt.pdf'));
 * ```
 */
export function computeContentSha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Milliseconds since the epoch of a date-ish value; `null` when empty. */
export function instantMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const ms =
    value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** The slice of `SmrtObject` the natural-key identity guard needs. */
interface NaturalKeyed {
  id?: string | null;
  slug?: string | null;
  context?: string | null;
  readonly isPersisted: boolean;
  getSlug(): Promise<unknown>;
  requireInsertOnSave(): void;
}

/**
 * Make a save write only the row its guards checked.
 *
 * Core's natural-key save adopts any same-owner row on
 * `(tenant_id, slug, context)` and upserts it without a revision predicate,
 * and these models have no human slug. So:
 *
 * - a fresh (never loaded, never saved) instance may only INSERT
 *   (`requireInsertOnSave`): naming an existing row's id is refused here, and
 *   a row that appears between this check and the write makes the INSERT
 *   fail rather than be adopted;
 * - an existing row is changed only through a loaded instance, whose save
 *   carries core's revision compare-and-swap, and it must keep the slug and
 *   context it is stored under, so the write targets that row and no other.
 *
 * @returns `true` when this save is an INSERT.
 * @throws {ExpenseError} `EXPENSE_IDENTITY_CONFLICT` when a fresh instance
 *   names an existing row, or a loaded one changes its natural key.
 */
export async function pinNaturalKey(
  model: string,
  object: NaturalKeyed,
  persisted: Record<string, unknown> | null,
): Promise<boolean> {
  await object.getSlug();
  if (!object.isPersisted) {
    if (persisted) {
      throw new ExpenseError(
        'EXPENSE_IDENTITY_CONFLICT',
        `${model} ${object.id} already exists; load it and save the loaded ` +
          'instance instead of creating one with its id.',
      );
    }
    object.requireInsertOnSave();
    return true;
  }
  if (
    persisted &&
    (String(persisted.slug ?? '') !== String(object.slug ?? '') ||
      String(persisted.context ?? '') !== String(object.context ?? ''))
  ) {
    throw new ExpenseError(
      'EXPENSE_IDENTITY_CONFLICT',
      `${model} ${object.id}: slug and context cannot change; they would ` +
        'point the save at a different row.',
    );
  }
  return false;
}

/** The error a refused natural-key INSERT is reported as. */
export function identityConflict(
  model: string,
  object: { id?: string | null; slug?: string | null },
  cause: unknown,
): ExpenseError {
  return new ExpenseError(
    'EXPENSE_IDENTITY_CONFLICT',
    `${model} ${object.id}: another row already uses slug ` +
      `'${object.slug}' in this tenant; a new ${model} cannot take it over.`,
    { cause },
  );
}

/**
 * The tenant a save will actually write: tenancy's `beforeSave` interceptor
 * fills an empty `tenantId` from the active tenant context, after the
 * model's own checks have run. Compare against this, not the raw field.
 */
export function effectiveTenant(
  tenantId: string | null | undefined,
): string | null {
  return tenantId ?? getTenantId() ?? null;
}
