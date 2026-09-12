/** Real tenant interceptor coverage for the core's compatible batch lifecycle. */
import {
  field,
  getChangesSince,
  ObjectRegistry,
  registerChangeFeedWriter,
  SmrtJunction,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../context';
import { TenantScoped, tenantId } from '../decorators';
import { disableTenancy, enableTenancy } from '../interceptor';

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

@smrt({
  tableName: 'tenant_batch_links',
  conflictColumns: ['tenant_id', 'owner_id', 'asset_id'],
})
@TenantScoped({ mode: 'required' })
class TenantBatchLink extends SmrtObject {
  @field({ required: true }) ownerId = '';
  @field({ required: true }) assetId = '';
  @field() sortOrder = 0;
  @tenantId({ nullable: false }) tenantId = '';
}
class TenantBatchLinks extends SmrtJunction<TenantBatchLink> {
  static readonly _itemClass = TenantBatchLink;
  protected leftField = 'ownerId';
  protected rightField = 'assetId';
}

describe('compatible tenant junction batches', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let links: TenantBatchLinks;
  beforeAll(async () => {
    ObjectRegistry.registerCollection('TenantBatchLink', TenantBatchLinks);
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['TenantBatchLink'],
    });
    links = await TenantBatchLinks.create({ db });
    enableTenancy();
    registerChangeFeedWriter();
  });
  afterAll(async () => {
    disableTenancy();
    await db?.close?.();
  });

  it('auto-populates tenant IDs and preserves peers during replace and detach', async () => {
    await withTenant({ tenantId: B }, () =>
      links.setLinks('owner', ['shared', 'peer']),
    );
    const probe = await withTenant(
      { tenantId: B },
      async () => (await links.byLeft('owner'))[0],
    );
    expect(SmrtObject.hasBaseJunctionLifecycle(TenantBatchLink.prototype)).toBe(
      true,
    );
    expect(probe.supportsJunctionBatch()).toBe(true);
    const query = vi.spyOn(db, 'query');
    await withTenant({ tenantId: A }, () =>
      links.setLinks('owner', ['shared', 'mine']),
    );
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).startsWith('INSERT INTO "tenant_batch_links"'),
      ),
    ).toHaveLength(1);
    query.mockRestore();
    await withTenant({ tenantId: A }, async () => {
      const rows = await links.byLeft('owner');
      expect(rows.every((row) => row.tenantId === A)).toBe(true);
      await links.setLinks('owner', ['replacement']);
      await links.detach('owner', 'replacement');
      expect(await links.byLeft('owner')).toEqual([]);
    });
    await withTenant({ tenantId: B }, async () => {
      expect((await links.byLeft('owner')).map((row) => row.assetId)).toEqual([
        'shared',
        'peer',
      ]);
    });
    const changes = (
      await getChangesSince(db, { since: 0, limit: 1000 })
    ).changes.filter((entry) => entry.table === 'tenant_batch_links');
    expect(changes.filter((entry) => entry.tenantId === A)).toHaveLength(6);
    expect(changes.filter((entry) => entry.tenantId === B)).toHaveLength(2);
  });

  it('denies missing context and cross-tenant filters before mutation', async () => {
    await expect(links.setLinks('denied', ['a'])).rejects.toMatchObject({
      code: 'TENANT_CONTEXT_REQUIRED',
    });
    await withTenant({ tenantId: A }, async () => {
      await expect(
        links.setLinks('owner', ['forged'], { tenantId: B }),
      ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });
      await expect(
        links.detach('owner', 'shared', { tenantId: B }),
      ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });
    });
  });
});
