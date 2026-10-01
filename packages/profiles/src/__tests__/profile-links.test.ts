/**
 * ProfileLink: a profile's ordered web links.
 *
 * Real in-memory SQLite with tenancy enabled under the default `'throw'`
 * policy, no DB mocking. The PostgreSQL behaviour (FK cascade, native UUIDs)
 * is pinned by `profile-links-postgres.test.ts`.
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
  normalizeProfileLinkUrl,
  type Profile,
  ProfileCollection,
  ProfileLink,
  ProfileLinkCollection,
  ProfileTypeCollection,
} from '../index.js';

const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b1';

describe('ProfileLink', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') await db.close();
  });

  async function person(tenantId: string, name = 'Mayor'): Promise<Profile> {
    const types = await ProfileTypeCollection.create({ db });
    const type = await withSystemContext(() =>
      types.getOrCreateBySlug('person', { name: 'Person' }),
    );
    const profiles = await ProfileCollection.create({ db });
    return withTenant({ tenantId }, async () => {
      const profile = await profiles.create({
        typeId: type.id as string,
        name,
      });
      await profile.save();
      return profile;
    });
  }

  function view(links: ProfileLink[]) {
    return links.map((link) => [
      link.platform,
      link.url,
      link.label,
      link.sortOrder,
    ]);
  }

  describe('normalizeProfileLinkUrl', () => {
    it('accepts http and https addresses', () => {
      expect(normalizeProfileLinkUrl(' https://facebook.com/town ')).toBe(
        'https://facebook.com/town',
      );
      expect(normalizeProfileLinkUrl('http://example.org')).toBe(
        'http://example.org/',
      );
    });

    it.each([
      '',
      'facebook.com/town',
      'javascript:alert(1)',
      'data:text/html,hi',
      'mailto:a@example.org',
      'ftp://example.org/file',
      'https://user:pw@example.org/',
      'https://example.org/a b',
    ])('refuses %j', (raw) => {
      expect(() => normalizeProfileLinkUrl(raw)).toThrow();
    });
  });

  it('keeps a same-labelled link of another profile apart (id slug, not label)', async () => {
    const mayor = await person(TENANT_A, 'Mayor');
    const clerk = await person(TENANT_A, 'Clerk');
    await withTenant({ tenantId: TENANT_A }, async () => {
      await mayor.setLinks([
        { platform: 'website', url: 'https://town.example/', label: 'Town' },
      ]);
      await clerk.setLinks([
        { platform: 'website', url: 'https://town.example/', label: 'Town' },
      ]);
    });
    const rows = await db.query(
      'SELECT id, slug, profile_id FROM profile_links ORDER BY profile_id',
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows as Array<{ id: string; slug: string }>) {
      expect(row.slug).toBe(row.id);
    }
  });

  it('replaceForProfile adds, keeps, reorders and removes in one call', async () => {
    const mayor = await person(TENANT_A);
    await withTenant({ tenantId: TENANT_A }, async () => {
      const first = await mayor.setLinks([
        { platform: 'facebook', url: 'https://facebook.com/mayor' },
        { platform: 'website', url: 'https://mayor.example/' },
        { platform: 'other', url: 'https://blog.example/', label: 'Blog' },
      ]);
      const facebookId = first[0].id;

      const second = await mayor.setLinks([
        { platform: 'other', url: 'https://blog.example/', label: 'My blog' },
        { platform: 'facebook', url: 'https://facebook.com/mayor' },
        { platform: 'x', url: 'https://x.com/mayor' },
        // Repeated address: kept once, at its first position.
        { platform: 'facebook', url: 'https://facebook.com/mayor' },
      ]);
      expect(view(second)).toEqual([
        ['other', 'https://blog.example/', 'My blog', 0],
        ['facebook', 'https://facebook.com/mayor', null, 1],
        ['x', 'https://x.com/mayor', null, 2],
      ]);
      // An address already on the profile keeps its row.
      expect(second[1].id).toBe(facebookId);
      expect(view(await mayor.getLinks())).toEqual(view(second));
    });
  });

  it('replaceForProfile changes nothing when a link is invalid', async () => {
    const mayor = await person(TENANT_A);
    await withTenant({ tenantId: TENANT_A }, async () => {
      await mayor.setLinks([
        { platform: 'website', url: 'https://mayor.example/' },
      ]);
      await expect(
        mayor.setLinks([
          { platform: 'x', url: 'https://x.com/mayor' },
          { platform: 'website', url: 'javascript:alert(1)' },
        ]),
      ).rejects.toThrow();
      await expect(
        mayor.setLinks([
          // @ts-expect-error: not a platform
          { platform: 'myspace', url: 'https://myspace.com/mayor' },
        ]),
      ).rejects.toThrow(/platform/);
      expect(view(await mayor.getLinks())).toEqual([
        ['website', 'https://mayor.example/', null, 0],
      ]);
    });
  });

  it('reorder follows the given ids and refuses an incomplete list', async () => {
    const mayor = await person(TENANT_A);
    const links = await ProfileLinkCollection.create({ db });
    await withTenant({ tenantId: TENANT_A }, async () => {
      const saved = await mayor.setLinks([
        { platform: 'facebook', url: 'https://facebook.com/mayor' },
        { platform: 'x', url: 'https://x.com/mayor' },
        { platform: 'website', url: 'https://mayor.example/' },
      ]);
      const ids = saved.map((link) => link.id as string);

      const reordered = await links.reorder(mayor.id as string, [
        ids[2],
        ids[0],
        ids[1],
      ]);
      expect(reordered.map((link) => link.platform)).toEqual([
        'website',
        'facebook',
        'x',
      ]);
      expect(
        (await links.listForProfile(mayor.id as string)).map(
          (link) => link.platform,
        ),
      ).toEqual(['website', 'facebook', 'x']);

      await expect(
        links.reorder(mayor.id as string, [ids[0], ids[1]]),
      ).rejects.toThrow(/exactly once/);
      await expect(
        links.reorder(mayor.id as string, [ids[0], ids[0], ids[1]]),
      ).rejects.toThrow(/exactly once/);
    });
  });

  it('links carry the profile tenant, even from a super-admin write', async () => {
    const mayor = await person(TENANT_A);
    await withTenant({ tenantId: TENANT_A, superAdminBypass: true }, () =>
      withSuperAdminBypass(() =>
        mayor.setLinks([{ platform: 'x', url: 'https://x.com/mayor' }]),
      ),
    );
    await withSystemContext(() =>
      mayor.setLinks([
        { platform: 'x', url: 'https://x.com/mayor' },
        { platform: 'website', url: 'https://mayor.example/' },
      ]),
    );
    const rows = await db.query('SELECT tenant_id FROM profile_links');
    expect(
      (rows.rows as Array<{ tenant_id: string }>).map((row) => row.tenant_id),
    ).toEqual([TENANT_A, TENANT_A]);
  });

  it('another tenant can neither read nor replace the links', async () => {
    const mayor = await person(TENANT_A);
    const links = await ProfileLinkCollection.create({ db });
    await withTenant({ tenantId: TENANT_A }, () =>
      mayor.setLinks([{ platform: 'x', url: 'https://x.com/mayor' }]),
    );

    await withTenant({ tenantId: TENANT_B }, async () => {
      expect(await links.listForProfile(mayor.id as string)).toEqual([]);
      await expect(
        links.replaceForProfile(mayor.id as string, [
          { platform: 'x', url: 'https://x.com/impostor' },
        ]),
      ).rejects.toThrow(/not found/);
    });

    const own = await withTenant({ tenantId: TENANT_A }, () =>
      links.listForProfile(mayor.id as string),
    );
    expect(view(own)).toEqual([['x', 'https://x.com/mayor', null, 0]]);
  });

  it('Profile.isPublic defaults to false and persists', async () => {
    const mayor = await person(TENANT_A);
    expect(mayor.isPublic).toBe(false);
    const profiles = await ProfileCollection.create({ db });
    await withTenant({ tenantId: TENANT_A }, async () => {
      mayor.isPublic = true;
      await mayor.save();
      const reloaded = await profiles.get({ id: mayor.id as string });
      expect(reloaded?.isPublic).toBe(true);
    });
  });

  it('a saved link refuses a bad platform or address', async () => {
    const mayor = await person(TENANT_A);
    await withTenant({ tenantId: TENANT_A }, async () => {
      const links = await ProfileLinkCollection.create({ db });
      await expect(
        (async () => {
          const bad = await links.create({
            profileId: mayor.id as string,
            platform: 'website',
            url: 'javascript:alert(1)',
          });
          await bad.save();
        })(),
      ).rejects.toThrow(/http/);
      const direct = new ProfileLink({
        db,
        profileId: mayor.id as string,
        url: 'https://mayor.example/',
      });
      // @ts-expect-error: not a platform
      direct.platform = 'myspace';
      await direct.initialize();
      await expect(direct.save()).rejects.toThrow(/platform/);
      expect(new ProfileLink({ tenantId: TENANT_A }).tenantId).toBe(TENANT_A);
    });
  });
});
