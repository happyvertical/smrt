import { isPostgresDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';

/**
 * Trusted exact-tenant kind metadata, independent of activation or membership.
 * The host owns resource selection and must separately verify active tenant and
 * signed/job/proof authority. PostgreSQL RLS-filtered absence is indeterminate
 * and throws; the helper never elevates the caller to establish family kind.
 * No session, context, name, roster or grant escapes.
 */
export async function isGroupTenant(
  db: DatabaseInterface,
  tenantId: string,
): Promise<boolean> {
  if (
    typeof tenantId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      tenantId,
    )
  )
    throw new Error('Tenant kind is unavailable');
  if (!(await db.get('tenants', { id: tenantId })))
    throw new Error('Tenant kind is unavailable');
  if (isPostgresDatabase(db)) {
    // Keep visibility and the bounded count in one statement: relation locking
    // prevents concurrent RLS changes from turning a hidden zero into absence.
    const result = await db.query(
      `SELECT
        (SELECT count(*)::integer FROM
          (SELECT id FROM education_groups WHERE tenant_id = ? LIMIT 2) AS exact_groups
        ) AS visible_count,
        row_security_active('education_groups'::regclass) AS rls_active`,
      tenantId,
    );
    const row = result.rows[0];
    if (result.rows.length !== 1) throw new Error('Tenant kind is unavailable');
    if (row.visible_count === 1) return true;
    if (row.visible_count === 0 && row.rls_active === false) return false;
    // A filtered zero cannot establish family kind. Never change the caller's
    // role, GUCs or permission context to obtain a broader metadata read.
    throw new Error('Tenant kind is unavailable');
  }
  const result = await db.query(
    'SELECT id FROM education_groups WHERE tenant_id = ? LIMIT 2',
    tenantId,
  );
  if (result.rows.length > 1) throw new Error('Tenant kind is unavailable');
  return result.rows.length === 1;
}
