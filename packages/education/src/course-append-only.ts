import type { SmrtObject } from '@happyvertical/smrt-core';

/** Shared guards for the append-only generation and review models. */
export function adopt(target: object, options: Record<string, unknown>) {
  for (const [key, value] of Object.entries(options))
    if (Object.hasOwn(target, key))
      (target as Record<string, unknown>)[key] = value;
}
export function requireText(value: unknown, message: string, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(message);
}
export function requireJson(
  value: string,
  shape: 'array' | 'object',
  what: string,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${what} must be JSON`);
  }
  if (
    shape === 'array'
      ? !Array.isArray(parsed)
      : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
  )
    throw new Error(`${what} must be a JSON ${shape}`);
}
/** Append-only rows reject any rewrite of an existing id; replays are service-level. */
export async function requireInsert(row: SmrtObject & { tenantId: string }) {
  if (!row.tenantId?.trim())
    throw new Error('Course generation and review require a tenant');
  if (row.id && (await row.db.get(row.tableName, { id: row.id })))
    throw new Error('Course generation and review history is immutable');
}
export async function requireOwned(
  row: SmrtObject & { tenantId: string },
  table: string,
  id: string,
  extra: Record<string, unknown> = {},
) {
  if (!(await row.db.get(table, { id, tenant_id: row.tenantId, ...extra })))
    throw new Error('Course generation and review parent ownership mismatch');
}
export function noDelete(): never {
  throw new Error(
    'Generation and review history is immutable; erasure requires an owning retention operation',
  );
}
export function validDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid timestamp');
}
