import type { SmrtObject, SmrtObjectOptions } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { HrError } from './types.js';

// Per-instance capability, deliberately absent from the package export surface.
const permitted = new WeakSet<SmrtObject>();

/** Whether a service is saving this instance right now. */
export function hasHrWrite(object: SmrtObject): boolean {
  return permitted.has(object);
}

/**
 * Guard for a model's `save()`.
 *
 * @throws HrError `HR_WRITE_FORBIDDEN` outside a service write
 */
export function assertHrWrite(object: SmrtObject): void {
  if (!hasHrWrite(object))
    throw new HrError(
      'HR_WRITE_FORBIDDEN',
      'HR records are writable only through EmploymentService and QualificationService.',
    );
}

/** Save one instance under the write capability; services only. */
export async function persistHr<T extends SmrtObject>(object: T): Promise<T> {
  permitted.add(object);
  try {
    await object.save();
    return object;
  } finally {
    permitted.delete(object);
  }
}

/**
 * The one way a service inserts an HR row. `collection.create()` saves
 * outside the write capability (so it always throws for HR models), and a
 * plain first `save()` would upsert onto an existing natural key. This builds
 * the instance through the model's public constructor and `initialize()`,
 * requires a real INSERT (`requireInsertOnSave()`), and saves it under the
 * capability. It uses no protected collection API.
 */
export async function insertHr<T extends SmrtObject>(
  Model: new (options: SmrtObjectOptions) => T,
  db: DatabaseInterface,
  values: Record<string, unknown>,
): Promise<T> {
  const row = await new Model({ db, _skipLoad: true, ...values }).initialize();
  row.requireInsertOnSave();
  return persistHr(row);
}
