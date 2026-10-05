import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  AuditLogCollection,
  createAuditWriter,
  ProfileCollection,
  ProfileTypeCollection,
  pruneAuditTrail,
  readAuditTrail,
} from '../index.js';

@smrt({
  tableName: 'issue_3460_organization_records',
  audit: true,
  tenantScoped: { field: 'organizationId', allowSuperAdminBypass: true },
})
class Issue3460OrganizationRecord extends SmrtObject {
  organizationId: string = '';
  title: string = '';
}
class Issue3460OrganizationRecords extends SmrtCollection<Issue3460OrganizationRecord> {
  static readonly _itemClass = Issue3460OrganizationRecord;
}
@smrt({
  tableName: 'issue_3460_tenant_records',
  audit: true,
  tenantScoped: true,
})
class Issue3460TenantRecord extends SmrtObject {
  tenantId: string = '';
  title: string = '';
}
class Issue3460TenantRecords extends SmrtCollection<Issue3460TenantRecord> {
  static readonly _itemClass = Issue3460TenantRecord;
}

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';

for (const type of ['sqlite', 'postgres'] as const) {
  const suite =
    type === 'postgres' && !isPostgresAvailable() ? describe.skip : describe;
  suite(`authorized audit trail and retention on ${type}`, () => {
    let isolated: IsolatedTestDbResult | undefined;
    let db: DatabaseInterface;
    let logs: AuditLogCollection;
    let actorId: string;
    beforeEach(async () => {
      if (type === 'postgres') {
        isolated = await createIsolatedTestDbFromManifest({
          includeObjects: [
            '@happyvertical/smrt-profiles:Profile',
            '@happyvertical/smrt-profiles:ProfileType',
            '@happyvertical/smrt-profiles:AuditLog',
            '@happyvertical/smrt-profiles:Issue3460OrganizationRecord',
            '@happyvertical/smrt-profiles:Issue3460TenantRecord',
          ],
        });
        db = isolated.db;
      } else db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
      enableTenancy();
      logs = await AuditLogCollection.create({ db });
      await withSystemContext(async () => {
        const types = await ProfileTypeCollection.create({ db });
        const type = await types.getOrCreateBySlug('person', {
          name: 'Person',
        });
        const profiles = await ProfileCollection.create({ db });
        const actor = await profiles.create({
          typeId: type.id,
          name: 'Audit actor',
        });
        actorId = actor.id as string;
      });
    });
    afterEach(async () => {
      disableTenancy();
      if (isolated) await isolated.cleanup();
      else await db?.close?.();
      isolated = undefined;
    });

    async function record(
      tenantId: string,
      resourceId: string,
      occurredAt: Date,
    ) {
      return await withTenant({ tenantId }, async () => {
        const entry = new AuditLog({
          db,
          profileId: actorId,
          tenantId,
          action: 'approved',
          resourceType: 'Job',
          resourceId,
          reason: 'Reviewed',
          changes: { status: { before: 'draft', after: 'approved' } },
        });
        await entry.initialize();
        entry.occurredAt = occurredAt;
        await entry.save();
        return entry;
      });
    }

    it('keeps model sensitive and disables every generated read transport', () => {
      const config = ObjectRegistry.getClassByConstructor(AuditLog)?.config;
      expect(config).toMatchObject({
        sensitive: true,
        api: false,
        cli: false,
        mcp: false,
      });
      const qualified =
        ObjectRegistry.getClassByConstructor(AuditLog)?.qualifiedName;
      expect(
        ObjectRegistry.getSchema(qualified as string)?.columns.occurred_at
          .default,
      ).toBe('current_timestamp');
    });

    it('checks principal/resource permission and tenant ownership for allowed and denied reads', async () => {
      await record(A, 'owned-job', new Date('2026-10-01T12:00:00Z'));
      await record(A, 'other-job', new Date('2026-10-02T12:00:00Z'));
      await record(B, 'owned-job', new Date('2026-10-03T12:00:00Z'));
      await withTenant({ tenantId: A }, async () => {
        const visible = await readAuditTrail(
          logs,
          (entry) => entry.resourceId === 'owned-job',
          {
            profileId: actorId,
            resourceType: 'Job',
            from: new Date('2026-10-01'),
            to: new Date('2026-10-02'),
          },
        );
        expect(visible).toHaveLength(1);
        expect(visible[0]).toMatchObject({
          tenantId: A,
          reason: 'Reviewed',
          changes: { status: { before: 'draft', after: 'approved' } },
        });
        expect(await readAuditTrail(logs, () => false)).toEqual([]);
        expect(
          await readAuditTrail(logs, () => {
            throw new Error('permissions unavailable');
          }),
        ).toEqual([]);
        expect(
          await readAuditTrail(logs, () => 'yes' as unknown as boolean),
        ).toEqual([]);
        expect(
          await readAuditTrail(logs, () => true, { resourceId: 'other-job' }),
        ).toHaveLength(1);
      });
      await withTenant({ tenantId: B }, async () => {
        expect(await readAuditTrail(logs, () => true)).toHaveLength(1);
      });
    });

    it('retains actual custom and default tenant ownership across administrative CRUD, tenant reads and retention', async () => {
      const records = await Issue3460OrganizationRecords.create({
        db,
        auditTrail: { actorId, writer: createAuditWriter() },
      });
      const defaults = await Issue3460TenantRecords.create({
        db,
        auditTrail: { actorId, writer: createAuditWriter() },
      });
      let resourceId = '';
      await withSystemContext(async () => {
        const owned = await records.create({
          organizationId: A,
          title: 'Before',
        });
        resourceId = owned.id as string;
        await records.create({ organizationId: B, title: 'Foreign' });
        await defaults.create({ tenantId: B, title: 'Default administrative' });
      });
      await withTenant({ tenantId: B, superAdminBypass: true }, async () => {
        await records.update(resourceId, { title: 'After' });
        await records.delete(resourceId);
      });
      await withSystemContext(async () => {
        const entries = await logs.list({ where: { resourceId } });
        expect(entries).toHaveLength(3);
        expect(entries.every((entry) => entry.tenantId === A)).toBe(true);
        expect(entries.map((entry) => entry.action).sort()).toEqual([
          'created',
          'deleted',
          'updated',
        ]);
        for (const entry of entries) {
          entry.occurredAt = new Date('2025-01-01');
          await entry.save();
        }
      });
      await withTenant({ tenantId: A }, async () => {
        expect(
          await readAuditTrail(logs, () => true, { resourceId }),
        ).toHaveLength(3);
        const normal = await records.create({ title: 'Normal tenant' });
        expect(normal.organizationId).toBe(A);
        const normalDefault = await defaults.create({
          title: 'Default normal',
        });
        expect(normalDefault.tenantId).toBe(A);
        const visible = await readAuditTrail(logs, () => true);
        expect(visible).toHaveLength(5);
        expect(visible.every((entry) => entry.tenantId === A)).toBe(true);
        expect(
          await pruneAuditTrail(logs, {
            maxAgeDays: 90,
            now: new Date(),
          }),
        ).toBe(3);
        expect(await readAuditTrail(logs, () => true, { resourceId })).toEqual(
          [],
        );
        expect(await readAuditTrail(logs, () => true)).toHaveLength(2);
      });
      await withTenant({ tenantId: B }, async () => {
        const foreign = await readAuditTrail(logs, () => true);
        expect(foreign).toHaveLength(2);
        expect(foreign.every((entry) => entry.tenantId === B)).toBe(true);
        expect(await readAuditTrail(logs, () => true, { resourceId })).toEqual(
          [],
        );
      });
    });

    it('rejects missing authorization, invalid dates and unbounded limits', async () => {
      await withTenant({ tenantId: A }, async () => {
        await expect(
          readAuditTrail(logs, undefined as unknown as () => boolean),
        ).rejects.toThrow('authorization');
        await expect(
          readAuditTrail(logs, () => true, { limit: 0 }),
        ).rejects.toThrow('Audit limit');
        await expect(
          readAuditTrail(logs, () => true, { limit: 1001 }),
        ).rejects.toThrow('Audit limit');
        await expect(
          readAuditTrail(logs, () => true, { from: new Date('bad') }),
        ).rejects.toThrow('valid Dates');
        await expect(
          readAuditTrail(logs, () => true, {
            from: new Date('2026-10-03'),
            to: new Date('2026-10-01'),
          }),
        ).rejects.toThrow('reversed');
      });
    });

    it('prunes a bounded old batch in current tenant and converges on retry', async () => {
      const old = new Date('2025-01-01');
      await record(A, 'old-1', old);
      await record(A, 'old-2', old);
      await record(A, 'recent', new Date('2026-10-01'));
      await record(B, 'foreign', old);
      await withTenant({ tenantId: A }, async () => {
        const options = {
          maxAgeDays: 90,
          now: new Date('2026-10-05'),
          batchSize: 1,
        };
        expect(await pruneAuditTrail(logs, options)).toBe(1);
        expect(await pruneAuditTrail(logs, options)).toBe(1);
        expect(await pruneAuditTrail(logs, options)).toBe(0);
        expect(
          (await readAuditTrail(logs, () => true)).map(
            (entry) => entry.resourceId,
          ),
        ).toEqual(['recent']);
        await expect(pruneAuditTrail(logs, { maxAgeDays: -1 })).rejects.toThrow(
          'positive age',
        );
      });
      await withTenant({ tenantId: B }, async () => {
        expect(await readAuditTrail(logs, () => true)).toHaveLength(1);
      });
    });

    it('writes the same actor/reason/diff shape via the transaction-bound sink', async () => {
      const writer = createAuditWriter();
      await withTenant({ tenantId: A }, async () => {
        await db.transaction(async (tx) => {
          await writer(
            {
              actorId,
              tenantId: A,
              action: 'corrected',
              resourceType: 'Job',
              resourceId: 'manual',
              reason: 'Approved correction',
              changes: { amount: { before: 100, after: 200 } },
            },
            tx,
          );
        });
        const entries = await readAuditTrail(logs, () => true);
        expect(entries[0]).toMatchObject({
          profileId: actorId,
          action: 'corrected',
          reason: 'Approved correction',
          changes: { amount: { before: 100, after: 200 } },
        });
      });
    });
  });
}
