/** Package-private command capabilities; never exported from the package root. */
import type { SmrtObject } from '@happyvertical/smrt-core';
export const allocationWrites = new WeakSet<SmrtObject>();
export const allocationHeads = new WeakMap<SmrtObject, string | null>();
export async function insertAllocation<T extends SmrtObject>(
  row: T,
): Promise<T> {
  await row.initialize();
  allocationWrites.add(row);
  try {
    await row.save();
    return row;
  } finally {
    allocationWrites.delete(row);
  }
}
