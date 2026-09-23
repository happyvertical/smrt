import type { DatabaseInterface } from '@happyvertical/sql';

/**
 * Remove every row-level-security policy `applyPostgresPermissionPolicies()`
 * installed in the current schema, and turn RLS back off on those tables.
 *
 * The policies are DDL: they commit on the shared per-package database and
 * outlive the isolated transaction a suite rolls back. Left behind, they
 * FORCE RLS onto every tenant-scoped table for each later suite in the
 * package. Under a superuser connection that was invisible (superusers bypass
 * RLS); under the CI lane's NOSUPERUSER/NOBYPASSRLS role it rejects ordinary
 * writes in unrelated suites, e.g. `resource_grants` in
 * `resource-grant-postgres.test.ts`.
 */
export async function resetPostgresPermissionPolicies(
  db: DatabaseInterface,
): Promise<void> {
  await db.query(`DO $smrt_rls_reset$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT schemaname, tablename, policyname
        FROM pg_catalog.pg_policies
        WHERE schemaname = current_schema()
      LOOP
        EXECUTE format('DROP POLICY %I ON %I.%I',
          r.policyname, r.schemaname, r.tablename);
      END LOOP;
      FOR r IN
        SELECT namespace.nspname, relation.relname
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = current_schema()
          AND relation.relkind IN ('r', 'p')
          AND (relation.relrowsecurity OR relation.relforcerowsecurity)
      LOOP
        EXECUTE format(
          'ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY, DISABLE ROW LEVEL SECURITY',
          r.nspname, r.relname);
      END LOOP;
    END
  $smrt_rls_reset$`);
}
