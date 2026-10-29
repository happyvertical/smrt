import type { DatabaseInterface } from '@happyvertical/sql';

/**
 * Trusted exact-tenant kind metadata, independent of activation or membership.
 * The host owns resource selection and must separately verify active tenant and
 * signed/job/proof authority. No session, context, name, roster or grant escapes.
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
  const result = await db.query(
    'SELECT id FROM education_groups WHERE tenant_id = ? LIMIT 2',
    tenantId,
  );
  if (result.rows.length > 1) throw new Error('Tenant kind is unavailable');
  return result.rows.length === 1;
}
