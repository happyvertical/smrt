import type { SmrtObject } from '@happyvertical/smrt-core';

// Per-instance capability, deliberately absent from the package export surface.
const permitted = new WeakSet<SmrtObject>();
export function assertRollupWrite(object: SmrtObject): void {
  if (!permitted.has(object))
    throw new Error(
      'Timecards and adjustments are writable only through PeriodRollupService.',
    );
}
export async function persistRollup<T extends SmrtObject>(
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

// Second capability: only reopen() may move a confirmed/submitted card back.
const reopening = new WeakSet<SmrtObject>();
export function isReopenWrite(object: SmrtObject): boolean {
  return reopening.has(object);
}
export async function persistReopen<T extends SmrtObject>(
  object: T,
): Promise<T> {
  reopening.add(object);
  try {
    return await persistRollup(object);
  } finally {
    reopening.delete(object);
  }
}
