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

export { asEngine, ENGINE_CONTEXT } from './db/test-support.ts';
