// Test helpers that name PostgreSQL settings (kept in engine/db/: nothing
// outside it may contain database-specific SQL, db-boundary.test.ts).

/**
 * The app's tables carry FORCED row-level security (#5189): even their owner
 * reads and writes nothing without a principal. A test that arranges or checks
 * rows with a raw connection acts as the engine: `smrt.system_context` is what
 * the policies' bypass reads (on a superuser, PGlite, it changes nothing).
 */
export const ENGINE_CONTEXT = `SELECT set_config('smrt.system_context', 'true', true)`;

/** `sql` on `db` in a transaction that acts as the engine; the rows. */
export async function asEngine(
  db: {
    transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
  },
  sql: string,
  params: unknown[] = [],
): Promise<Array<Record<string, any>>> {
  return db.transaction(async (tx: any) => {
    await tx.query(ENGINE_CONTEXT);
    return (await tx.query(sql, params)).rows as Array<Record<string, any>>;
  });
}
