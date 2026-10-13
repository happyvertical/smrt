import { randomUUID } from 'node:crypto';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { applyPostgresPermissionPolicies } from '../services/index.js';
import { resetPostgresPermissionPolicies } from './helpers/postgres-rls-reset.js';

@smrt({
  tableName: 'aliased_action_rls_records',
  collection: 'aliased_action_rls_records',
  tenantScoped: { mode: 'required', field: 'tenantId' },
  api: {
    include: ['list', 'create', 'archive'],
    routes: { archive: { method: 'POST' } },
  },
  operationPermissions: {
    archive: { action: 'create', databaseActions: ['UPDATE'] },
  },
})
class AliasedActionRlsRecord extends SmrtObject {
  tenantId = '';
  status = 'active';
  async archive(): Promise<void> {}
}
void AliasedActionRlsRecord;

describe.skipIf(!isPostgresAvailable())(
  'custom action alias SQL authority',
  () => {
    it('uses the aliased grant for UPDATE while retaining tenant and read-only denials', async () => {
      const isolated = await createIsolatedTestDbFromManifest();
      const db = await getDatabase(isolated.config);
      const admin = await getDatabase({
        type: 'postgres',
        url: process.env.SMRT_TEST_POSTGRES_ADMIN_URL ?? isolated.config.url,
        dbid: randomUUID(),
      });
      const role = `report_alias_${randomUUID().replaceAll('-', '')}`;
      const tenant = randomUUID();
      const otherTenant = randomUUID();
      const id = randomUUID();
      const otherId = randomUUID();
      try {
        await admin.query(
          `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`,
        );
        await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
        await admin.query(
          `GRANT SELECT, UPDATE ON aliased_action_rls_records TO "${role}"`,
        );
        await admin.query(
          'INSERT INTO aliased_action_rls_records (id, slug, context, tenant_id, status) VALUES ($1::uuid, $1::text, $2, $3, $4), ($5::uuid, $5::text, $2, $6, $4)',
          id,
          '',
          tenant,
          'active',
          otherId,
          otherTenant,
        );
        await applyPostgresPermissionPolicies({ db });
        async function update(permissions: string[]) {
          return admin.transaction(async (tx) => {
            await tx.query(`SET LOCAL ROLE "${role}"`);
            await tx.query(
              "SELECT set_config('smrt.tenant_id', $1, true)",
              tenant,
            );
            await tx.query(
              "SELECT set_config('smrt.permissions', $1, true)",
              JSON.stringify(permissions),
            );
            const result = await tx.query(
              "UPDATE aliased_action_rls_records SET status = 'archived' WHERE id IN ($1, $2) RETURNING id",
              id,
              otherId,
            );
            return result.rows.map((row) => row.id);
          });
        }
        expect(await update(['aliased_action_rls_records.read'])).toEqual([]);
        expect(
          await update([
            'aliased_action_rls_records.read',
            'aliased_action_rls_records.create',
          ]),
        ).toEqual([id]);
        const rows = await admin.query(
          'SELECT status FROM aliased_action_rls_records WHERE id = $1',
          otherId,
        );
        expect(rows.rows[0].status).toBe('active');
      } finally {
        await resetPostgresPermissionPolicies(db);
        await admin.query(
          'DELETE FROM aliased_action_rls_records WHERE id IN ($1, $2)',
          id,
          otherId,
        );
        await admin.query(`DROP OWNED BY "${role}"`);
        await admin.query(`DROP ROLE "${role}"`);
        await isolated.cleanup();
        await admin.close?.();
        await db.close?.();
      }
    }, 60_000);
  },
);
