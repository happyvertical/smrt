/**
 * Profile metadata carries its profile's tenant.
 *
 * `Profile.addMetadata()` used to create `ProfileMetadata` rows with a NULL
 * `tenant_id` whenever the save ran without tenant auto-population: under a
 * super-admin bypass (an operator editing a town's person inside that town's
 * tenant context) and in system/no-context code. Separately, the
 * `ProfileMetadata` / `ProfileMetafield` constructors dropped an explicit
 * `tenantId` option (the class-field initializer ran after `super()`), so a
 * caller could not pass the tenant either.
 *
 * Real in-memory SQLite, tenancy enabled under the default `'throw'` policy,
 * no DB mocking.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withSuperAdminBypass,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProfileCollection,
  ProfileMetadata,
  ProfileMetadataCollection,
  ProfileMetafield,
  ProfileMetafieldCollection,
  ProfileTypeCollection,
} from '../index.js';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

describe('profile metadata tenancy', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') await db.close();
  });

  async function seed(tenantId: string) {
    const types = await ProfileTypeCollection.create({ db });
    const type = await withSystemContext(() =>
      types.getOrCreateBySlug('person', { name: 'Person' }),
    );
    const profiles = await ProfileCollection.create({ db });
    const metafields = await ProfileMetafieldCollection.create({ db });
    return withTenant({ tenantId }, async () => {
      const profile = await profiles.create({
        typeId: type.id as string,
        name: `Person of ${tenantId.slice(-1)}`,
      });
      await profile.save();
      const phone = await metafields.create({ slug: 'phone', name: 'Phone' });
      await phone.save();
      return { profile, phone };
    });
  }

  async function rowTenants(table: string): Promise<Array<string | null>> {
    const result = await db.query(`SELECT tenant_id FROM ${table}`);
    return (result.rows as Array<{ tenant_id: string | null }>).map(
      (row) => row.tenant_id,
    );
  }

  it('constructors keep an explicit tenantId', () => {
    expect(new ProfileMetadata({ tenantId: TENANT_A }).tenantId).toBe(TENANT_A);
    expect(new ProfileMetafield({ tenantId: TENANT_A }).tenantId).toBe(
      TENANT_A,
    );
  });

  it('a write in tenant context stamps the profile tenant', async () => {
    const { profile, phone } = await seed(TENANT_A);
    expect(phone.tenantId).toBe(TENANT_A);

    await withTenant({ tenantId: TENANT_A }, () =>
      profile.addMetadata('phone', '555-0100'),
    );

    expect(await rowTenants('profile_metadata')).toEqual([TENANT_A]);
    expect(await rowTenants('profile_metafields')).toEqual([TENANT_A]);
  });

  it('a super-admin write inside a tenant context still stamps the profile tenant', async () => {
    const { profile } = await seed(TENANT_A);

    await withTenant({ tenantId: TENANT_A, superAdminBypass: true }, () =>
      withSuperAdminBypass(() => profile.addMetadata('phone', '555-0101')),
    );

    expect(await rowTenants('profile_metadata')).toEqual([TENANT_A]);
  });

  it('a system-context write stamps the profile tenant', async () => {
    const { profile } = await seed(TENANT_A);

    await withSystemContext(() => profile.addMetadata('phone', '555-0102'));

    expect(await rowTenants('profile_metadata')).toEqual([TENANT_A]);
  });

  it('prefers the profile tenant metafield over another tenant with the same slug', async () => {
    await seed(TENANT_B);
    const { profile, phone } = await seed(TENANT_A);

    await withTenant({ tenantId: TENANT_A, superAdminBypass: true }, () =>
      withSuperAdminBypass(() => profile.addMetadata('phone', '555-0103')),
    );

    const rows = await db.query(
      'SELECT metafield_id, tenant_id FROM profile_metadata',
    );
    expect(rows.rows).toEqual([
      { metafield_id: phone.id, tenant_id: TENANT_A },
    ]);
  });

  it('a tenant-less profile under system context never takes another tenant metafield', async () => {
    await seed(TENANT_B);
    const types = await ProfileTypeCollection.create({ db });
    const type = await withSystemContext(() =>
      types.getOrCreateBySlug('person', { name: 'Person' }),
    );
    const profiles = await ProfileCollection.create({ db });
    const globalProfile = await withSystemContext(async () => {
      const created = await profiles.create({
        typeId: type.id as string,
        name: 'Global person',
      });
      await created.save();
      return created;
    });

    await expect(
      withSystemContext(() => globalProfile.addMetadata('phone', '555-0105')),
    ).rejects.toThrow("Metafield 'phone' not found");
    expect(await rowTenants('profile_metadata')).toEqual([]);
  });

  it('a cross-tenant read does not see the metadata', async () => {
    const { profile } = await seed(TENANT_A);
    await withTenant({ tenantId: TENANT_A }, () =>
      profile.addMetadata('phone', '555-0104'),
    );

    const metadata = await ProfileMetadataCollection.create({ db });
    const own = await withTenant({ tenantId: TENANT_A }, () =>
      metadata.getByProfile(profile.id as string),
    );
    const other = await withTenant({ tenantId: TENANT_B }, () =>
      metadata.getByProfile(profile.id as string),
    );

    expect(own.map((row) => row.value)).toEqual(['555-0104']);
    expect(other).toEqual([]);
  });
});
