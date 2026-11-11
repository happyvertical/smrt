/** One-hop names use scoped SQL before search, ordering and pagination. */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { crossPackageRef, field } from '../decorators';
import { APIGenerator } from '../generators/rest';
import { GlobalInterceptors } from '../interceptors';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { setRuntimeExposureGate } from '../runtime-exposure';
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
@smrt({
  idType: 'text',
  display: {
    references: { skuId: '@happyvertical/smrt-core:DisplayProfile' },
    label: { via: 'skuId', field: 'name', fallback: 'Unknown item' },
  },
})
class DisplayTextReference extends SmrtObject {
  @field() skuId = '';
  @field() tenantId: string | null = null;
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
  setRuntimeExposureGate(undefined);
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
  it('composes a public projection without fetching, retaining row scopes and refusing gated fields', async () => {
    await seed('Visible a');
    await seed('Hidden a', 'a', false);
    await seed('Visible b', 'b');
    scopeTargets();
    activeTenant = 'a';
    await profiles.list({ select: ['id'] });
    const query = vi.spyOn(db, 'query');
    const plan = await profiles.buildProjectionQuery({
      select: ['id', 'name'],
      where: { 'name like': '%a' },
    });
    expect(query).not.toHaveBeenCalled();
    const rows = await db.query(plan.sql, ...plan.values);
    expect(rows.rows).toEqual([expect.objectContaining({ name: 'Visible a' })]);
    await expect(
      profiles.buildProjectionQuery({ select: ['secret'] }),
    ).rejects.toThrow(/sensitive/);
    await expect(
      profiles.buildProjectionQuery({ select: ['internalName'] }),
    ).rejects.toThrow(/readPermission/);
    await expect(
      profiles.buildProjectionQuery({
        select: ['name'],
        where: { secret: 'hidden' },
      }),
    ).rejects.toThrow(/sensitive/);
    query.mockRestore();
  });

  it('labels an explicitly declared plain-text reference without changing its storage type or crossing tenants', async () => {
    const source = await ObjectRegistry.getCollection('DisplayTextReference', {
      db,
    });
    const good = await profiles.create({ name: 'Named item', tenantId: 'a' });
    const other = await profiles.create({
      name: 'Private item',
      tenantId: 'b',
    });
    const hidden = await profiles.create({
      name: 'Hidden item',
      tenantId: 'a',
      visible: false,
    });
    await source.create({ skuId: good.id, tenantId: 'a' });
    await source.create({ skuId: other.id, tenantId: 'a' });
    await source.create({ skuId: hidden.id, tenantId: 'a' });
    await source.create({ skuId: 'external-not-a-uuid', tenantId: 'a' });
    scopeTargets();
    const rows = await source.list({ displayLabel: true });
    expect(rows.map((r) => r.toJSON().displayLabel)).toEqual([
      'Named item',
      'Unknown item',
      'Unknown item',
      'Unknown item',
    ]);
    expect(
      ObjectRegistry.getFields('DisplayTextReference').get('skuId')?.type,
    ).toBe('text');
  });

  it('keeps ordinary list/get/count and persisted selects independent of the display target', async () => {
    const row = await customers.create({
      profileId: 'absent-profile',
      tenantId: null,
    });
    await db.query('DROP TABLE display_profiles');
    const query = vi.spyOn(db, 'query');
    const tables = vi.spyOn(db, 'tableExists');
    expect((await customers.list()).map((item) => item.id)).toEqual([row.id]);
    expect((await customers.get({ id: row.id }))?.toJSON()).not.toHaveProperty(
      'displayLabel',
    );
    expect(await customers.count()).toBe(1);
    expect(await customers.list({ select: ['id', 'profileId'] })).toEqual([
      { id: row.id, profileId: 'absent-profile' },
    ]);
    expect(
      tables.mock.calls.some(([table]) => table === 'display_profiles'),
    ).toBe(false);
    expect(
      query.mock.calls.some(([sql]) =>
        /JOIN|display_profiles/.test(String(sql)),
      ),
    ).toBe(false);
  });

  it('returns the declared fallback for an explicitly requested label when its target table is absent', async () => {
    const row = await customers.create({
      profileId: 'absent-profile',
      tenantId: null,
    });
    await db.query('DROP TABLE display_profiles');
    expect(
      (await customers.list({ displayLabel: true }))[0].toJSON(),
    ).toMatchObject({
      id: row.id,
      displayLabel: 'Unnamed customer',
    });
    expect(
      (await customers.get({ id: row.id }, { displayLabel: true }))?.toJSON(),
    ).toMatchObject({
      displayLabel: 'Unnamed customer',
    });
    expect(
      await customers.list({
        select: ['id', 'displayLabel'],
        orderBy: 'displayLabel',
      }),
    ).toEqual([{ id: row.id, displayLabel: 'Unnamed customer' }]);
    expect(
      await customers.count({ where: { 'displayLabel like': '%Unnamed%' } }),
    ).toBe(1);
    expect(
      await customers.list({ where: { display_label: 'Someone else' } }),
    ).toEqual([]);
    const handler = new APIGenerator(
      { basePath: '/api' },
      { db },
    ).generateHandler();
    const restList = await handler(
      new Request(
        'http://fixture/api/displaycustomers?orderBy=displayLabel&displayLabel[like]=%25Unnamed%25',
      ),
    );
    expect(restList.status).toBe(200);
    expect(await restList.json()).toMatchObject([
      { id: row.id, displayLabel: 'Unnamed customer' },
    ]);
    const restGet = await handler(
      new Request(`http://fixture/api/displaycustomers/${row.id}`),
    );
    expect(restGet.status).toBe(200);
    expect(await restGet.json()).toMatchObject({
      displayLabel: 'Unnamed customer',
    });
    // Absence is not cached: a normally migrated target becomes readable later.
    await getTestDatabase({ db, classes: ['DisplayProfile'] });
    const profile = await profiles.create({
      name: 'Available now',
      tenantId: null,
    });
    if (!profile.id) throw new Error('Profile fixture has no id');
    row.profileId = profile.id;
    await row.save();
    expect(
      (await customers.list({ displayLabel: true }))[0].toJSON().displayLabel,
    ).toBe('Available now');
  });

  it('propagates target storage failures instead of treating them as an absent target', async () => {
    await customers.create({ profileId: 'absent-profile', tenantId: null });
    const tableExists = db.tableExists.bind(db);
    vi.spyOn(db, 'tableExists').mockImplementation(async (table) => {
      if (table === 'display_profiles') throw new Error('schema unavailable');
      return tableExists(table);
    });
    await expect(customers.list({ displayLabel: true })).rejects.toThrow(
      'schema unavailable',
    );
  });

  it('projects an explicitly selected name as a plain row without hydrating the target', async () => {
    const { customer } = await seed('Maya', null);
    expect(await customers.list({ select: ['id', 'displayLabel'] })).toEqual([
      { id: customer.id, displayLabel: 'Maya' },
    ]);
  });

  it('keeps persisted-only read helpers from accepting a virtual select column', async () => {
    await expect(
      customers.facets({ fields: ['displayLabel'] }),
    ).rejects.toThrow("Invalid select field: 'displayLabel'");
  });

  it('sorts and searches before slicing in one SELECT, independent of page size', async () => {
    await seed('Zoe');
    await seed('Ada');
    await seed('Maya');
    await customers.list({ limit: 1, displayLabel: true }); // warm table verification
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
    const point = await customers.get(
      { id: found[0].id },
      { displayLabel: true },
    );
    expect(point?.toJSON().displayLabel).toBe('Maya');
    await point?.save(); // label must not become a database column on save
    expect(
      (
        await customers.get({ id: found[0].id }, { displayLabel: true })
      )?.toJSON().displayLabel,
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
        (await focused.list({ displayLabel: true })).map(
          (row) => row.toJSON().displayLabel,
        ),
      ).toEqual(['Unnamed customer']);
    } finally {
      await focusedDb.close?.();
    }
  });

  it('uses a clear fallback for missing and blank targets', async () => {
    await customers.create({ profileId: 'missing', tenantId: 'a' });
    await seed('   ');
    const rows = await customers.list({ displayLabel: true });
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
      (
        await customers.get({ id: badLink.id }, { displayLabel: true })
      )?.toJSON().displayLabel,
    ).toBe('Unnamed customer');
    expect(
      (
        await customers.get({ id: globalLink.id }, { displayLabel: true })
      )?.toJSON().displayLabel,
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
    await expect(restricted.list({ displayLabel: true })).rejects.toThrow(
      /sensitive/,
    );
  });

  it('fails closed on target policy errors', async () => {
    await seed('Ada');
    GlobalInterceptors.register({
      name: 'display-test-scope',
      beforeList(className) {
        if (className === 'DisplayProfile') throw new Error('read denied');
      },
    });
    await expect(customers.list({ displayLabel: true })).rejects.toThrow(
      'read denied',
    );
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

  it('checks live exposure before any projection SQL, even with a retained ETag', async () => {
    await seed('Visible', null);
    const handler = new APIGenerator(
      { basePath: '/api' },
      { db },
    ).generateHandler();
    let enabled = true;
    setRuntimeExposureGate({ isEnabled: () => enabled });
    const url = 'http://localhost/api/displaycustomers?orderBy=displayLabel';
    const first = await handler(new Request(url));
    expect(first.status).toBe(200);
    const sql = vi.spyOn(db, 'query');
    enabled = false;
    for (const path of [url, `${url.split('?')[0]}/missing`]) {
      const response = await handler(
        new Request(path, {
          headers: { 'if-none-match': first.headers.get('etag') ?? '' },
        }),
      );
      expect(response.status).toBe(404);
    }
    expect(sql).not.toHaveBeenCalled();
    enabled = true;
    expect((await handler(new Request(url))).status).toBe(200);
    expect(
      sql.mock.calls.some(([query]) => /LEFT JOIN/.test(String(query))),
    ).toBe(true);
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
      (
        await customers.get({ id: customer.id }, { displayLabel: true })
      )?.toJSON().displayLabel,
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
      (
        await customers.get({ id: customer.id }, { displayLabel: true })
      )?.toJSON().displayLabel,
    ).toBe('After');
  });
});
