/** Q1: the ordinary collection/REST write creates and edits the linked contact atomically. */
import { getTestDatabase } from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import {
  ProfileCollection,
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
