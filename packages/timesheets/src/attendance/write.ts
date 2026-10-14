import type { SmrtObject } from '@happyvertical/smrt-core';

// Per-instance capability, deliberately absent from the package export surface:
// the only code that can lift closed-interval immutability is the correction
// service, and only for the single save it is performing.
const permitted = new WeakSet<SmrtObject>();

/** True while `object` is being saved by `AttendanceCorrectionService`. */
export function isCorrectionWrite(object: SmrtObject): boolean {
  return permitted.has(object);
}

/** Save `object` with closed-interval immutability lifted for this one write. */
export async function persistCorrection<T extends SmrtObject>(
  object: T,
): Promise<T> {
  permitted.add(object);
  try {
    await object.save();
    return object;
  } finally {
    permitted.delete(object);
  }
}

/** Delete a closed break or segment through the correction capability. */
export async function deleteCorrection<T extends SmrtObject>(
  object: T,
): Promise<void> {
  permitted.add(object);
  try {
    await object.delete();
  } finally {
    permitted.delete(object);
  }
}
