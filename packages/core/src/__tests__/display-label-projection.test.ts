/** One-hop names use scoped SQL before search, ordering and pagination. */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { crossPackageRef, field } from '../decorators';
import { APIGenerator } from '../generators/rest';
import { GlobalInterceptors } from '../interceptors';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({ idType: 'text' })
class DisplayProfile extends SmrtObject {
  @field()
  name = '';
  @field()
  tenantId: string | null = null;
  @field()
  visible = true;
  @field({ sensitive: true })
  secret = '';
  @field({ readPermission: 'profiles.internal' })
  internalName = '';
}

@smrt({
  idType: 'text',
  api: { public: true, include: ['list', 'get', 'update'] },
  display: {
    label: { via: 'profileId', field: 'name', fallback: 'Unnamed customer' },
  },
})
class DisplayCustomer extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-core:DisplayProfile')
  profileId = '';
  @field()
  tenantId: string | null = null;
}
class DisplayCustomers extends SmrtCollection<DisplayCustomer> {
  static readonly _itemClass = DisplayCustomer;
}
class DisplayProfiles extends SmrtCollection<DisplayProfile> {
  static readonly _itemClass = DisplayProfile;
}

@smrt({ tableStrategy: 'sti', idType: 'text' })
class DisplayRestrictedProfile extends SmrtObject {
  @field()
  name = '';
}
@smrt()
class DisplayRestrictedChild extends DisplayRestrictedProfile {
  @field({ sensitive: true })
  override name = '';
}
@smrt({
  idType: 'text',
  display: {
    label: { via: 'profileId', field: 'name', fallback: 'Unavailable' },
  },
})
class DisplayRestrictedCustomer extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-core:DisplayRestrictedProfile')
  profileId = '';
}

@smrt({ idType: 'text', display: { label: 'displayLabel' } })
class DisplayOwnLabel extends SmrtObject {
  @field()
  displayLabel = '';
}

let db: DatabaseInterface;
let customers: DisplayCustomers;
let profiles: DisplayProfiles;
let activeTenant: string | null | undefined;

beforeEach(async () => {
  db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  customers = await DisplayCustomers.create({ db });
  profiles = await DisplayProfiles.create({ db });
  activeTenant = undefined;
});
afterEach(async () => {
  GlobalInterceptors.unregister('display-test-scope');
  await db.close?.();
  vi.restoreAllMocks();
});

async function seed(
  name: string,
  tenantId: string | null = 'a',
  visible = true,
) {
  const profile = await profiles.create({
    name,
    tenantId,
    visible,
    slug: `profile-${crypto.randomUUID()}`,
  });
  if (!profile.id) throw new Error('Profile fixture has no id');
  const customer = await customers.create({ profileId: profile.id, tenantId });
  return { profile, customer };
}

function scopeTargets() {
  GlobalInterceptors.register({
    name: 'display-test-scope',
    beforeList(className, options) {
      if (className !== 'DisplayProfile') return options;
      return {
        ...options,
        where: {
          ...options.where,
          visible: true,
          ...(activeTenant !== undefined ? { tenantId: activeTenant } : {}),
        },
      };
    },
  });
}

describe('display label projection', () => {
  it('sorts and searches before slicing in one SELECT, independent of page size', async () => {
    await seed('Zoe');
    await seed('Ada');
    await seed('Maya');
    await customers.list({ limit: 1 }); // warm table verification
    const query = vi.spyOn(db, 'query');
    const page = await customers.list({
      orderBy: 'displayLabel ASC, id ASC',
      limit: 2,
      offset: 1,
    });
    expect(page.map((row) => row.toJSON().displayLabel)).toEqual([
      'Maya',
      'Zoe',
    ]);
    const selects = () =>
      query.mock.calls.filter(([sql]) =>
        /^\s*(?:SELECT|WITH)\b/i.test(String(sql)),
      );
    expect(selects()).toHaveLength(1);
    query.mockClear();
    const found = await customers.list({
      where: { 'displayLabel like': '%ay%' },
      orderBy: 'displayLabel DESC',
      limit: 1,
    });
    expect(found.map((row) => row.toPublicJSON().displayLabel)).toEqual([
      'Maya',
    ]);
    expect(selects()).toHaveLength(1);
    expect(
      await customers.count({ where: { 'displayLabel like': '%ay%' } }),
    ).toBe(1);
    const point = await customers.get({ id: found[0].id });
    expect(point?.toJSON().displayLabel).toBe('Maya');
    await point?.save(); // label must not become a database column on save
    expect(
      (await customers.get({ id: found[0].id }))?.toJSON().displayLabel,
    ).toBe('Maya');
  });

  it('preserves ordinary models that already own a displayLabel field', async () => {
    const own = await ObjectRegistry.getCollection<DisplayOwnLabel>(
      'DisplayOwnLabel',
      { db },
    );
    const record = await own.create({ displayLabel: 'Own name' });
    expect((await own.get({ id: record.id }))?.displayLabel).toBe('Own name');
  });

  it('provisions display targets for an explicitly scoped test database', async () => {
    const focusedDb = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['DisplayCustomer'],
    });
    try {
      const focused = await DisplayCustomers.create({ db: focusedDb });
      await focused.create({ profileId: 'missing', tenantId: 'a' });
      expect(
        (await focused.list()).map((row) => row.toJSON().displayLabel),
      ).toEqual(['Unnamed customer']);
    } finally {
      await focusedDb.close?.();
    }
  });

  it('uses a clear fallback for missing and blank targets', async () => {
    await customers.create({ profileId: 'missing', tenantId: 'a' });
    await seed('   ');
    const rows = await customers.list();
    expect(rows.map((row) => row.toJSON().displayLabel)).toEqual([
      'Unnamed customer',
      'Unnamed customer',
    ]);
  });

  it('keeps target row policies in search/sort and rejects cross-owner links without a context', async () => {
    const { profile } = await seed('Private b', 'b');
    if (!profile.id) throw new Error('Profile fixture has no id');
    const badLink = await customers.create({
      profileId: profile.id,
      tenantId: 'a',
    });
    const globalLink = await customers.create({
      profileId: profile.id,
      tenantId: null,
    });
    expect(
      (await customers.get({ id: badLink.id }))?.toJSON().displayLabel,
    ).toBe('Unnamed customer');
    expect(
      (await customers.get({ id: globalLink.id }))?.toJSON().displayLabel,
    ).toBe('Unnamed customer');
    await seed('Visible a');
    await seed('Hidden a', 'a', false);
    await seed('Global', null);
    scopeTargets();
    activeTenant = 'a';
    expect(
      await customers.list({ where: { 'displayLabel like': '%Private%' } }),
    ).toEqual([]);
    expect(
      await customers.list({ where: { 'displayLabel like': '%Hidden%' } }),
    ).toEqual([]);
    expect(
      (
        await customers.list({ where: { 'displayLabel like': '%Visible%' } })
      ).map((row) => row.toJSON().displayLabel),
    ).toEqual(['Visible a']);
    activeTenant = 'b';
    expect(
      (
        await customers.list({ where: { 'displayLabel like': '%Private%' } })
      ).map((row) => row.toJSON().displayLabel),
    ).toEqual(['Private b']);
    activeTenant = null;
    expect(
      (
        await customers.list({ where: { 'displayLabel like': '%Global%' } })
      ).map((row) => row.toJSON().displayLabel),
    ).toEqual(['Global']);
    expect(
      await customers.list({ where: { 'displayLabel like': '%Private%' } }),
    ).toEqual([]);
  });

  it('refuses a target label that an STI descendant makes sensitive', async () => {
    const restricted = await ObjectRegistry.getCollection(
      'DisplayRestrictedCustomer',
      { db },
    );
    await expect(restricted.list()).rejects.toThrow(/sensitive/);
  });

  it('fails closed on target policy errors', async () => {
    await seed('Ada');
    GlobalInterceptors.register({
      name: 'display-test-scope',
      beforeList(className) {
        if (className === 'DisplayProfile') throw new Error('read denied');
      },
    });
    await expect(customers.list()).rejects.toThrow('read denied');
  });

  it.each([
    'secret',
    'internalName',
  ])('refuses %s before SQL can expose an ordering/filter oracle', async (name) => {
    class UnsafeCustomer extends SmrtObject {
      profileId = '';
    }
    crossPackageRef('@happyvertical/smrt-core:DisplayProfile')(
      UnsafeCustomer.prototype,
      'profileId',
    );
    ObjectRegistry.register(UnsafeCustomer, {
      display: {
        label: { via: 'profileId', field: name, fallback: 'Unavailable' },
      },
    });
    const unsafe = await ObjectRegistry.getCollection('UnsafeCustomer', { db });
    // Provision only the fixture's declared schema; production never creates schema.
    await db.query(
      'CREATE TABLE IF NOT EXISTS unsafe_customers (id TEXT, profile_id TEXT)',
    );
    await expect(unsafe.list({ orderBy: 'displayLabel' })).rejects.toThrow(
      /sensitive|readPermission/,
    );
  });

  it('REST revalidates when the linked name changes and ignores label writes', async () => {
    const { profile, customer } = await seed('Before', null);
    const api = new APIGenerator({ basePath: '/api' }, { db });
    const url =
      'http://localhost/api/displaycustomers?displayLabel[like]=%25Before%25&orderBy=displayLabel%20ASC';
    const first = await api.generateHandler()(new Request(url));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject([{ displayLabel: 'Before' }]);
    const etag = first.headers.get('etag');
    profile.name = 'After';
    await profile.save();
    const next = await api.generateHandler()(
      new Request(url, { headers: { 'if-none-match': etag ?? '' } }),
    );
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual([]);
    expect(
      (await customers.get({ id: customer.id }))?.toJSON().displayLabel,
    ).toBe('After');
    const update = await api.generateHandler()(
      new Request(`http://localhost/api/displaycustomers/${customer.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayLabel: 'Injected' }),
      }),
    );
    expect(update.status).toBe(200);
    expect(
      (await customers.get({ id: customer.id }))?.toJSON().displayLabel,
    ).toBe('After');
  });
});
