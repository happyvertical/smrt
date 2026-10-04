import type {
  SmrtCollection,
  SmrtCreateInput,
  SmrtObject,
} from '@happyvertical/smrt-core';
import { HrError } from './types.js';

// Per-instance capability, deliberately absent from the package export surface.
const permitted = new WeakSet<SmrtObject>();
export function hasHrWrite(object: SmrtObject): boolean {
  return permitted.has(object);
}
export function assertHrWrite(object: SmrtObject): void {
  if (!hasHrWrite(object))
    throw new HrError(
      'HR_WRITE_FORBIDDEN',
      'HR records are writable only through EmploymentService and QualificationService.',
    );
}
export async function persistHr<T extends SmrtObject>(object: T): Promise<T> {
  permitted.add(object);
  try {
    await object.save();
    return object;
  } finally {
    permitted.delete(object);
  }
}
// collection.create() saves, which the models refuse; build the row through
// the collection's own creation path and hand it to persistHr() instead. The
// row must be a real INSERT: a first save() would otherwise upsert onto an
// existing natural key.
export async function draftHr<T extends SmrtObject>(
  collection: SmrtCollection<T>,
  fields: SmrtCreateInput<T>,
): Promise<T> {
  const row = await (
    collection as unknown as {
      createUnsaved(options: SmrtCreateInput<T>): Promise<T>;
    }
  ).createUnsaved(fields);
  row.requireInsertOnSave();
  return row;
}
