import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantGuestGrantCollection } from '../collections/TenantGuestGrantCollection.js';

describe('TenantGuestGrant (#5196)', () => {
  let db: DatabaseInterface;
  let grants: TenantGuestGrantCollection;
  let tenants: TenantCollection;

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Tenant', 'TenantGuestGrant'],
    });
    grants = await TenantGuestGrantCollection.create({ db });
    tenants = await TenantCollection.create({ db });
  });

  afterEach(async () => {
    if (typeof db.close === 'function') await db.close();
  });

  async function makeTenant(slug: string): Promise<string> {
    const tenant = await tenants.create({ name: slug, slug });
    return tenant.id as string;
  }

  it('stores a grant per tenant and lists only that tenant', async () => {
    const a = await makeTenant('guest-a');
    const b = await makeTenant('guest-b');
    await grants.create({
      tenantId: a,
      permissionSlug: 'products.read',
      grantedBy: 'u1',
    });
    await grants.create({ tenantId: b, permissionSlug: 'events.read' });

    expect(await grants.getGrantedSlugs(a)).toEqual(['products.read']);
    expect(await grants.getGrantedSlugs(b)).toEqual(['events.read']);
  });

  it('keeps one row per (tenant, permission) pair', async () => {
    const a = await makeTenant('guest-dup');
    await grants.create({ tenantId: a, permissionSlug: 'products.read' });
    await grants.create({ tenantId: a, permissionSlug: 'products.read' });
    await grants.create({ tenantId: a, permissionSlug: 'products.create' });

    expect((await grants.findByTenant(a)).length).toBe(2);
    const unique = (await db.query(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tenant_guest_grants'",
    )) as unknown as { rows?: Array<{ sql?: string }> };
    const ddl = JSON.stringify(unique);
    expect(ddl).toMatch(/UNIQUE/i);
    expect(ddl).toMatch(/tenant_id/);
    expect(ddl).toMatch(/permission_slug/);
  });

  it('references Tenant with NO ACTION, not CASCADE', async () => {
    const result = (await db.query(
      "SELECT sql FROM sqlite_master WHERE name='tenant_guest_grants'",
    )) as unknown as { rows?: Array<{ sql?: string }> };
    const ddl = JSON.stringify(result);
    expect(ddl).toMatch(/REFERENCES\s+\\?"?tenants/i);
    expect(ddl).toMatch(/ON DELETE NO ACTION/i);
    expect(ddl).not.toMatch(/ON DELETE CASCADE/i);
  });
});
