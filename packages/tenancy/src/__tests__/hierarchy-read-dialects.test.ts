import { SmrtCollection, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { describe, expect, it } from 'vitest';
import { withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import { runTenantHierarchyReadScope } from '../tenant-hierarchy-read-scope.js';

@smrt({ tableName: 'hierarchy_read_records' })
@TenantScoped({ mode: 'optional' })
class HierarchyReadRecord extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;
  category = '';
}
class HierarchyReadRecords extends SmrtCollection<HierarchyReadRecord> {
  static readonly _itemClass = HierarchyReadRecord;
}

const SELF = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANCESTOR = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SIBLING = 'cccccccc-3333-4333-8333-cccccccccccc';

describe.each(['sqlite', 'duckdb'] as const)('hierarchy list on %s', (type) => {
  it('includes NULL only for catalogs and ANDs every caller DNF branch', async () => {
    const db = await getTestDatabase({
      type,
      url: ':memory:',
      classes: ['HierarchyReadRecord'],
    });
    try {
      const records = await HierarchyReadRecords.create({ db });
      for (const owner of [null, SELF, ANCESTOR, SIBLING]) {
        for (const category of ['keep', 'drop']) {
          await records.create({ tenantId: owner, category });
        }
      }
      enableTenancy();
      await withTenant({ tenantId: SELF, userId: 'reader' }, async () => {
        for (const includeGlobal of [true, false]) {
          await runTenantHierarchyReadScope(
            {
              actorTenantId: SELF,
              actorUserId: 'reader',
              collections: ['@happyvertical/smrt-tenancy:HierarchyReadRecord'],
              tenantIds: [SELF, ANCESTOR],
              includeGlobal,
            },
            async () => {
              const rows = await records.list({
                where: [[{ category: 'keep' }], [{ category: 'absent' }]],
              });
              expect(rows.map((row) => row.tenantId).sort()).toEqual(
                (includeGlobal
                  ? [SELF, ANCESTOR, null]
                  : [SELF, ANCESTOR]
                ).sort(),
              );
              expect(rows.every((row) => row.category === 'keep')).toBe(true);
            },
          );
        }
        expect(
          (await records.list({})).every((row) => row.tenantId === SELF),
        ).toBe(true);
      });
    } finally {
      disableTenancy();
      await db.close?.();
    }
  });
});
