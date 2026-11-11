/** Q1: the ordinary collection/REST write creates and edits the linked contact atomically. */
import { DatabaseError, getTestDatabase } from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import {
  ProfileCollection,
  ProfileMetafieldCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection';
import { Customer } from '../models/Customer';

let db: Awaited<ReturnType<typeof getTestDatabase>> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  disableTenancy();
  await db?.close?.();
  db = undefined;
});
async function setup() {
  db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  const customers = await CustomerCollection.create({ db });
  const profiles = await ProfileCollection.create({ db });
  enableTenancy();
  return { customers, profiles };
}

describe('Customer inline contact writes', () => {
  it('projects contact columns without per-row reads, filters/orders email before pagination, and never dirties reads', async () => {
    const { customers, profiles } = await setup();
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const one = await customers.create({
        name: 'Ada',
        email: 'z@example.test',
        phone: '555-0111',
      });
      const two = await customers.create({
        name: 'Bea',
        email: 'a@example.test',
        phone: '555-0222',
      });
      await customers.list({ displayLabel: true });
      const query = vi.spyOn(db!, 'query');
      await customers.list({ displayLabel: true, limit: 1 });
      const firstCount = query.mock.calls.filter(([sql]) =>
        /^SELECT/i.test(String(sql).trim()),
      ).length;
      expect(firstCount).toBe(1);
      query.mockClear();
      const list = await customers.list({ displayLabel: true, limit: 50 });
      expect(
        query.mock.calls.filter(([sql]) => /^SELECT/i.test(String(sql).trim())),
      ).toHaveLength(firstCount);
      expect(list.map((row) => row.toJSON())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: one.id,
            name: 'Ada',
            email: 'z@example.test',
            phone: '555-0111',
          }),
          expect.objectContaining({
            id: two.id,
            name: 'Bea',
            email: 'a@example.test',
            phone: '555-0222',
          }),
        ]),
      );
      expect(
        (await customers.list({ orderBy: 'email ASC', limit: 1 }))[0].id,
      ).toBe(two.id);
      expect(
        (await customers.list({ where: { 'email like': '%z@%' } })).map(
          (row) => row.id,
        ),
      ).toEqual([one.id]);
      expect(await customers.count({ where: { 'email like': '%z@%' } })).toBe(
        1,
      );
      expect(
        (await customers.list({ orderBy: 'phone DESC', limit: 1 }))[0].id,
      ).toBe(two.id);
      expect(
        (await customers.list({ where: { 'phone like': '%0111' } })).map(
          (row) => row.id,
        ),
      ).toEqual([one.id]);
      expect(await customers.count({ where: { 'phone like': '%0111' } })).toBe(
        1,
      );
      // A projected snapshot is not a pending edit: saving it must preserve a later contact update.
      const read = list.find((row) => row.id === one.id)!;
      const profile = await profiles.get(one.profileId);
      profile!.email = 'fresh@example.test';
      await profile!.save();
      await read.save();
      expect((await profiles.get(one.profileId, { cache: false }))?.email).toBe(
        'fresh@example.test',
      );
      await customers.update(one.id!, {
        name: 'Ada Updated',
        email: '',
        phone: '',
      });
      expect(
        (await customers.list({ displayLabel: true }))
          .find((row) => row.id === one.id)
          ?.toJSON(),
      ).toMatchObject({ name: 'Ada Updated', email: '', phone: '' });
    });
  });

  it.each([
    { storage: 'no phone tables', extra: [] },
    { storage: 'definitions only', extra: ['ProfileMetafield'] },
  ])('reads names and email without optional phone tables ($storage)', async ({
    extra,
  }) => {
    db = await getTestDatabase({
      classes: ['Customer', 'Profile', 'ProfileType', ...extra],
    });
    const customers = await CustomerCollection.create({ db });
    enableTenancy();
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const member = await customers.create({
        name: 'No phone storage',
        email: 'contact@example.test',
      });
      expect(
        (await customers.list({ displayLabel: true }))[0].toJSON(),
      ).toMatchObject({
        name: 'No phone storage',
        email: 'contact@example.test',
        phone: '',
      });
      expect(
        (await customers.get(member.id!, { displayLabel: true }))?.toJSON(),
      ).toMatchObject({
        name: 'No phone storage',
        email: 'contact@example.test',
        phone: '',
      });
      expect(await customers.count({ where: { phone: '' } })).toBe(1);
    });
  });

  it.each([
    new Error('metadata policy denied'),
    DatabaseError.schemaMissing('unrelated_table', 'ProfileMetafield'),
  ])('propagates metadata failures outside its optional tables (%s)', async (error) => {
    const { customers } = await setup();
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await customers.create({ name: 'Existing contact' });
      vi.spyOn(
        ProfileMetafieldCollection.prototype,
        'buildProjectionQuery',
      ).mockRejectedValueOnce(error);
      await expect(customers.list({ displayLabel: true })).rejects.toBe(error);
    });
  });

  it('creates the name, email and metadata phone in the parent transaction and serves them for editing', async () => {
    const { customers, profiles } = await setup();
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const member = await customers.create({
        name: 'Maya Member',
        email: 'maya@example.test',
        phone: '555-0117',
      });
      const profile = await profiles.get(member.profileId);
      expect(profile?.toJSON()).toMatchObject({
        name: 'Maya Member',
        email: 'maya@example.test',
        tenantId: 'tenant-a',
      });
      expect(await profile?.getTypeSlug()).toBe('person');
      expect(profile?.toJSON()._meta_type).not.toContain('Bot');
      expect(await profile?.getMetadata()).toMatchObject({ phone: '555-0117' });
      const read = await customers.get(member.id!, {
        displayLabel: true,
        cache: false,
      });
      expect(read?.toJSON()).toMatchObject({
        displayLabel: 'Maya Member',
        name: 'Maya Member',
        email: 'maya@example.test',
        phone: '555-0117',
      });
      const saved = await customers.update(member.id!, {
        name: 'Maya Updated',
        email: 'new@example.test',
        phone: '555-0118',
      });
      expect(saved).not.toBeNull();
      expect(
        (await profiles.get(member.profileId, { cache: false }))?.name,
      ).toBe('Maya Updated');
      expect(
        (await customers.list({ displayLabel: true }))[0].toJSON().displayLabel,
      ).toBe('Maya Updated');
    });
  });

  it.each([
    '',
    '   ',
  ])('accepts a blank optional phone (%j) from a create form without creating metadata', async (phone) => {
    const { customers, profiles } = await setup();
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const member = await customers.create({
        name: 'Ada Member',
        email: 'ada@example.test',
        phone,
      });
      const profile = await profiles.get(member.profileId);
      expect(profile?.name).toBe('Ada Member');
      expect(await profile?.getMetadata()).not.toHaveProperty('phone');
      expect(
        (await customers.list({ displayLabel: true }))[0].toJSON().displayLabel,
      ).toBe('Ada Member');
    });
  });

  it('clears a phone with the existing metadata removal API and rolls the removal back if the member save fails', async () => {
    const { customers, profiles } = await setup();
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const member = await customers.create({ name: 'Ada', phone: '555-0117' });
      const normalize = vi
        .spyOn(
          Customer.prototype as unknown as {
            normalizePersistenceData(): undefined;
          },
          'normalizePersistenceData',
        )
        .mockImplementationOnce(() => {
          throw new Error('parent failed');
        });
      await expect(
        customers.update(member.id!, { phone: '' }),
      ).rejects.toThrow();
      normalize.mockRestore();
      expect(
        await (
          await profiles.get(member.profileId, { cache: false })
        )?.getMetadata(),
      ).toMatchObject({ phone: '555-0117' });
      await customers.update(member.id!, { phone: '' });
      expect(
        await (
          await profiles.get(member.profileId, { cache: false })
        )?.getMetadata(),
      ).not.toHaveProperty('phone');
    });
  });

  it('keeps explicitly owned phone metadata on the same tenant without an ambient context', async () => {
    const { customers, profiles } = await setup();
    const member = await customers.create({
      tenantId: 'explicit-tenant',
      name: 'Explicit owner',
      phone: '555-0199',
    });
    expect((await profiles.get(member.profileId))?.tenantId).toBe(
      'explicit-tenant',
    );
    expect(
      await (await profiles.get(member.profileId))?.getMetadata(),
    ).toMatchObject({ phone: '555-0199' });
  });

  it('does not hydrate inline values from a legacy global contact into a tenant member', async () => {
    const { customers, profiles } = await setup();
    const types = await ProfileTypeCollection.create({ db });
    const type = await types.getOrCreateBySlug('person', { name: 'Person' });
    const profile = await profiles.create({
      name: 'Global contact',
      email: 'global@example.test',
      typeId: type.id,
    });
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const member = await customers.create({ profileId: profile.id! });
      const read = await customers.get(member.id!, {
        displayLabel: true,
        cache: false,
      });
      expect(read?.toJSON()).toMatchObject({
        displayLabel: 'Unnamed customer',
      });
      for (const field of ['name', 'email', 'phone'])
        expect(read?.toJSON()[field]).toBeUndefined();
    });
  });

  it('still links an existing contact without creating another one', async () => {
    const { customers, profiles } = await setup();
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const types = await ProfileTypeCollection.create({ db });
      const type = await types.getOrCreateBySlug('person', { name: 'Person' });
      const profile = await profiles.create({
        name: 'Existing person',
        typeId: type.id,
      });
      const count = await profiles.count();
      const member = await customers.create({
        profileId: profile.id!,
        name: '',
        email: '',
        phone: '',
      });
      expect(member.profileId).toBe(profile.id);
      expect(await profiles.count()).toBe(count);
      expect((await profiles.get(profile.id!, { cache: false }))?.name).toBe(
        'Existing person',
      );
    });
  });

  it('rolls back the contact and metadata when the parent write fails, then permits retry', async () => {
    const { customers, profiles } = await setup();
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const before = await profiles.count();
      const normalize = vi
        .spyOn(
          Customer.prototype as unknown as {
            normalizePersistenceData(): undefined;
          },
          'normalizePersistenceData',
        )
        .mockImplementation(() => {
          throw new Error('parent refused');
        });
      await expect(
        customers.create({ name: 'Must roll back', phone: '555-0000' }),
      ).rejects.toThrow();
      expect(await profiles.count()).toBe(before);
      expect(await customers.count()).toBe(0);
      expect(
        (await db!.query('SELECT * FROM profile_metadata')).rows,
      ).toHaveLength(0);
      normalize.mockRestore();
      expect(
        (await customers.create({ name: 'Retry' })).profileId,
      ).toBeTruthy();
    });
  });

  it('rolls back linked edits when the parent update is refused', async () => {
    const { customers, profiles } = await setup();
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const member = await customers.create({ name: 'Original' });
      vi.spyOn(
        Customer.prototype as unknown as {
          normalizePersistenceData(): undefined;
        },
        'normalizePersistenceData',
      ).mockImplementation(() => {
        throw new Error('parent refused');
      });
      await expect(
        customers.update(String(member.id), { name: 'Must roll back' }),
      ).rejects.toThrow();
      expect(
        (await profiles.get(member.profileId, { cache: false }))?.name,
      ).toBe('Original');
    });
  });

  it('never renames an existing selection or a newly relinked contact with stale inline values', async () => {
    const { customers, profiles } = await setup();
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const first = await customers.create({ name: 'First member' });
      const second = await customers.create({ name: 'Second member' });
      await expect(
        customers.create({ profileId: second.profileId, name: 'Overwrite' }),
      ).rejects.toThrow();
      await expect(
        customers.update(String(first.id), {
          profileId: second.profileId,
          name: 'Stale name',
        }),
      ).rejects.toThrow();
      expect(
        (await profiles.get(second.profileId, { cache: false }))?.name,
      ).toBe('Second member');
      expect(
        (await customers.get(String(first.id), { cache: false }))?.profileId,
      ).toBe(first.profileId);
    });
  });

  it('refuses linked edits across tenant ownership', async () => {
    const { customers, profiles } = await setup();
    let profileId = '';
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      const member = await customers.create({ name: 'Other tenant' });
      profileId = member.profileId;
    });
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await expect(
        customers.create({ profileId, name: 'Hijack' }),
      ).rejects.toThrow();
      expect(await customers.count()).toBe(0);
    });
    await withTenant({ tenantId: 'tenant-b' }, async () =>
      expect((await profiles.get(profileId))?.name).toBe('Other tenant'),
    );
  });

  it('accepts inline fields on the authenticated generated REST create and update paths', async () => {
    await setup();
    const handler = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      {
        db,
        tenantId: 'tenant-a',
        user: { id: 'owner' },
        permissions: ['customers.create', 'customers.update', 'customers.read'],
      },
    ).generateHandler();
    const created = await handler(
      new Request('http://localhost/api/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'REST Member',
          email: 'rest@example.test',
          phone: '555-0100',
          tenantId: 'tenant-b',
        }),
      }),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const member = await created.json();
    expect(member.name).toBe('REST Member');
    const updated = await handler(
      new Request(`http://localhost/api/customers/${member.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'REST Updated' }),
      }),
    );
    expect(updated.status, await updated.clone().text()).toBe(200);
  });
});
