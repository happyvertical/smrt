/**
 * Cleanup for the optional PostgreSQL suites' scratch databases.
 *
 * The CI role (`smrt_ci`) has CREATEDB and CREATEROLE but is not a superuser.
 * `DROP DATABASE ... WITH (FORCE)` must terminate every other session on the
 * database, and that role may not terminate a session owned by a role whose
 * privileges it lacks (a login role a test created, or a server process), so
 * FORCE fails with 42501 even when every test passed. A plain DROP waits out
 * autovacuum by itself; a session that is still closing makes it fail with
 * 55006 ("being accessed by other users"), so it retries that error briefly,
 * then falls back to FORCE once, which still ends the CI role's own sessions.
 * Close every handle the suite opened before calling this.
 */

const IN_USE = /55006|is being accessed by other users/;

export async function dropScratchDatabase(
  admin: { query(sql: string): Promise<unknown> } | undefined,
  /** The database name as an SQL identifier (quote it if it needs quoting). */
  identifier: string,
  { attempts = 40, waitMs = 250 } = {},
): Promise<void> {
  if (!admin) return;
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${identifier}`);
      return;
    } catch (error) {
      if (!IN_USE.test(String(error))) throw error;
      if (attempt >= attempts) {
        await admin.query(`DROP DATABASE IF EXISTS ${identifier} WITH (FORCE)`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
