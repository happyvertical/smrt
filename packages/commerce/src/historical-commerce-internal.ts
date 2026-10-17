/** Command-only authority for immutable original financial source children. */
const writers = new WeakSet<object>();
export async function withHistoricalCommerceWrite<T>(
  object: object,
  apply: () => Promise<T>,
): Promise<T> {
  if (writers.has(object)) return apply();
  writers.add(object);
  try {
    return await apply();
  } finally {
    writers.delete(object);
  }
}
export function assertHistoricalCommerceWrite(object: object): void {
  if (!writers.has(object))
    throw new Error(
      'Historical financial records require their public historical Commerce command',
    );
}
