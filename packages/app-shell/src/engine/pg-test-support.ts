// Helpers of the real-server suites (`*.postgres.test.ts`, #5188).

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The SQLSTATE of an error: the SDK wraps a driver's error in its own
 * `DatabaseError` (whose `code` is not a SQLSTATE) and keeps the driver's as
 * `cause`, so look down the chain for the first five-character state.
 */
export function sqlstateOf(error: unknown): string | undefined {
  let e = error as { code?: unknown; cause?: unknown } | undefined;
  for (let i = 0; e && i < 6; i++, e = e.cause as typeof e) {
    if (typeof e.code === 'string' && SQLSTATE.test(e.code)) return e.code;
  }
  return undefined;
}

/** Run `fn` and return the SQLSTATE it failed with, or undefined when it did not fail. */
export async function sqlstate(fn: () => Promise<unknown>) {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return sqlstateOf(e) ?? 'unknown';
  }
}

/** `url` with another login (for connecting as a role made by the test). */
export function urlAs(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

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
