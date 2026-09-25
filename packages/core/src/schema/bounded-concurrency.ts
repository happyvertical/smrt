/**
 * Bounded-concurrency map for read-only introspection and probe queries.
 *
 * Schema diagnostics (`SchemaComparer.compare()`, the foreign-key orphan
 * report) issue one or more catalog/probe queries per table. Run strictly one
 * after another, their wall time is `queries × network round trip`, which is
 * minutes on a wide schema reached over a high-latency link (a ~280-table
 * `db:status` issued ~5,100 sequential round trips: ~30 s next to the
 * database, 11 min over a ~120 ms RTT link).
 * Running a bounded number in flight on a pooled connection divides that by
 * the concurrency limit without changing what is queried.
 *
 * Results are returned in input order. A limit of 1 is exactly the
 * sequential loop it replaces: items run in order and the first failure stops
 * scheduling further items. With a larger limit, the first failure also stops
 * scheduling; items already in flight are awaited (never left as unhandled
 * rejections) before that first error is rethrown.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const width = Math.max(
    1,
    Math.min(Number.isFinite(limit) ? Math.floor(limit) : 1, items.length),
  );
  let next = 0;
  let failure: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  if (failure) throw failure.error;
  return results;
}

/**
 * Default number of concurrent read-only catalog introspection queries on
 * PostgreSQL. Well under the `@happyvertical/sql` pool default (20).
 */
export const POSTGRES_INTROSPECTION_CONCURRENCY = 8;

/**
 * Default number of concurrent data-scanning probes (e.g. orphan `COUNT(*)`)
 * on PostgreSQL. Lower than introspection: these read table data, and a
 * diagnostic must not load a production primary.
 */
export const POSTGRES_PROBE_CONCURRENCY = 4;
