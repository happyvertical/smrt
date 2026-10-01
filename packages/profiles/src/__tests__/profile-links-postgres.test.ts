/**
 * ProfileLink against real PostgreSQL: native UUID columns, the declared
 * `ON DELETE CASCADE` from `profile_links.profile_id` to `profiles`, the
 * transactional replace/reorder, and tenant-stamped metadata. Gated on
 * `DATABASE_URL`
 * (`pnpm --filter @happyvertical/smrt-profiles test:postgres`).
 */

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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Profile,
  ProfileCollection,
  ProfileLinkCollection,
  ProfileMetafieldCollection,
  ProfileTypeCollection,
} from '../index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('ProfileLink on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  const tenantId = crypto.randomUUID();

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        '@happyvertical/smrt-profiles:Profile',
        '@happyvertical/smrt-profiles:ProfileType',
        '@happyvertical/smrt-profiles:ProfileLink',
        '@happyvertical/smrt-profiles:ProfileMetafield',
        '@happyvertical/smrt-profiles:ProfileMetadata',
      ],
    });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await isolated?.cleanup();
    isolated = undefined;
  });

  async function person(): Promise<Profile> {
    const db = isolated?.db;
    const types = await ProfileTypeCollection.create({ db });
    const type = await withSystemContext(() =>
      types.getOrCreateBySlug('person', { name: 'Person' }),
    );
    const profiles = await ProfileCollection.create({ db });
    return withTenant({ tenantId }, async () => {
      const profile = await profiles.create({
        typeId: type.id as string,
        name: 'Councillor',
      });
      await profile.save();
      return profile;
    });
  }

  it('declares profile_id as a cascading foreign key', async () => {
    const result = await isolated?.db.query(
      `SELECT c.confdeltype
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_class p ON p.oid = c.confrelid
        WHERE t.relname = 'profile_links' AND p.relname = 'profiles'
          AND c.contype = 'f'`,
    );
    expect(result?.rows).toEqual([{ confdeltype: 'c' }]);
  });

  it('replaces, reorders and cascades with the profile', async () => {
    const councillor = await person();
    const links = await ProfileLinkCollection.create({ db: isolated?.db });

    const saved = await withTenant({ tenantId }, () =>
      councillor.setLinks([
        { platform: 'facebook', url: 'https://facebook.com/councillor' },
        { platform: 'website', url: 'https://councillor.example/' },
      ]),
    );
    const reordered = await withTenant({ tenantId }, () =>
      links.reorder(councillor.id as string, [
        saved[1].id as string,
        saved[0].id as string,
      ]),
    );
    expect(reordered.map((link) => link.platform)).toEqual([
      'website',
      'facebook',
    ]);

    const rows = await isolated?.db.query(
      `SELECT platform, CAST(sort_order AS INTEGER) AS sort_order,
              CAST(tenant_id AS VARCHAR) AS tenant_id
         FROM profile_links ORDER BY sort_order`,
    );
    expect(rows?.rows).toEqual([
      { platform: 'website', sort_order: 0, tenant_id: tenantId },
      { platform: 'facebook', sort_order: 1, tenant_id: tenantId },
    ]);

    // A failed replace rolls back: the list is unchanged.
    await expect(
      withTenant({ tenantId }, () =>
        councillor.setLinks([
          { platform: 'x', url: 'https://x.com/councillor' },
          { platform: 'website', url: 'javascript:alert(1)' },
        ]),
      ),
    ).rejects.toThrow();
    const unchanged = await withTenant({ tenantId }, () =>
      links.listForProfile(councillor.id as string),
    );
    expect(unchanged.map((link) => link.platform)).toEqual([
      'website',
      'facebook',
    ]);

    await isolated?.db.query('DELETE FROM profiles WHERE id = ?', [
      councillor.id,
    ]);
    const left = await isolated?.db.query(
      'SELECT COUNT(*)::int AS n FROM profile_links',
    );
    expect(left?.rows).toEqual([{ n: 0 }]);
  });

  it('stamps metadata with the profile tenant under system context', async () => {
    const councillor = await person();
    const metafields = await ProfileMetafieldCollection.create({
      db: isolated?.db,
    });
    await withTenant({ tenantId }, () =>
      metafields.getOrCreateBySlug('phone', { name: 'Phone' }),
    );
    await withSystemContext(() => councillor.addMetadata('phone', '555-0199'));
    const rows = await isolated?.db.query(
      `SELECT CAST(md.tenant_id AS VARCHAR) AS tenant_id,
              CAST(mf.tenant_id AS VARCHAR) AS metafield_tenant_id
         FROM profile_metadata md
         JOIN profile_metafields mf ON mf.id = md.metafield_id`,
    );
    expect(rows?.rows).toEqual([
      { tenant_id: tenantId, metafield_tenant_id: tenantId },
    ]);
  });
});
