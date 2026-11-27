// Per-model staff access (#5197 S1): the grant store, the staff principal and
// `callerOf`. SQLite stands in for shell.db; no route is involved.
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppDefinition,
  OWNER_SLUG,
  type VersionRecord,
} from '../../engine/index.ts';
import {
  ModelAccessGrant,
  ModelAccessGrantCollection,
} from '../objects/ModelAccessGrant.ts';
import { callerOf } from './http.ts';
import { clearGrants } from './model-access.ts';
import { type Principal, runAs, staffPrincipalFor } from './owner.ts';
import { openShell, type ShellHarness } from './test-support.ts';
import { ShellVersionStore } from './version-store.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
});
afterAll(async () => {
  await h.close();
});

const def = (...models: string[]): AppDefinition =>
  ({
    format: 1,
    name: 'My app',
    recipes: [],
    models: Object.fromEntries(
      models.map((m) => [m, { fields: { title: { type: 'text' } } }]),
    ),
  }) as unknown as AppDefinition;

const staffAs = async (slug: string, status = MembershipStatus.ACTIVE) => {
  const users = await UserCollection.create({ db: h.db });
  const key = `${slug}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await users.create({ email: `${key}@x.test`, username: key });
  await user.save();
  const role = await (
    await RoleCollection.create({ db: h.db })
  ).findSystemRoleBySlug(slug);
  const m = await (await MembershipCollection.create({ db: h.db })).create({
    userId: user.id as string,
    tenantId: h.owner.tenantId,
    roleId: role?.id as string,
    status,
  });
  await m.save();
  return { id: user.id as string, tenantId: h.owner.tenantId } as Principal;
};

const asOwner = <T>(fn: () => Promise<T>) => runAs(h.owner, fn);
const rows = () =>
  asOwner(async () =>
    (await ModelAccessGrantCollection.create({ db: h.db })).list({
      limit: 100,
    }),
  );
const wipe = () => h.db.query('DELETE FROM model_access_grants');

describe('ModelAccessGrant', () => {
  it('is owner only and idempotent per tenant + model + action', async () => {
    await wipe();
    const d = def('Chore');
    await expect(
      runAs(h.member, () => ModelAccessGrant.grant(d, 'Chore', 'read')),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runAs(h.member, () => ModelAccessGrant.list()),
    ).rejects.toMatchObject({ status: 403 });
    await asOwner(() => ModelAccessGrant.grant(d, 'Chore', 'read'));
    await asOwner(() => ModelAccessGrant.grant(d, 'Chore', 'read'));
    await asOwner(() => ModelAccessGrant.grant(d, 'Chore', 'create'));
    expect(await rows()).toHaveLength(2);
    expect(await asOwner(() => ModelAccessGrant.list())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: 'Chore', action: 'read' }),
      ]),
    );
    await expect(
      runAs(h.member, () => ModelAccessGrant.revoke('Chore', 'read')),
    ).rejects.toMatchObject({ status: 403 });
    expect(await asOwner(() => ModelAccessGrant.revoke('Chore', 'read'))).toBe(
      true,
    );
    expect(await asOwner(() => ModelAccessGrant.revoke('Chore', 'read'))).toBe(
      false,
    );
    expect(await rows()).toHaveLength(1);
  });

  it('refuses delete, method slugs and unknown models or actions', async () => {
    await wipe();
    const d = def('Chore');
    for (const action of [
      'delete',
      'list',
      'get',
      'Chore.markDone',
      'u_chores.delete',
      '',
    ])
      await expect(
        asOwner(() => ModelAccessGrant.grant(d, 'Chore', action)),
      ).rejects.toThrow(/cannot be granted/);
    await expect(
      asOwner(() => ModelAccessGrant.grant(d, 'Nope', 'read')),
    ).rejects.toThrow(/no model/);
    await expect(
      asOwner(() => ModelAccessGrant.revoke('Chore', 'delete')),
    ).rejects.toThrow(/cannot be granted/);
    expect(await rows()).toHaveLength(0);
  });
});

describe('staffPrincipalFor', () => {
  it('has no permissions without grants', async () => {
    await wipe();
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    const p = await staffPrincipalFor(staff, staff.tenantId, def('Chore'));
    expect(p.kind).toBe('user');
    expect(p.userId).toBe(staff.id);
    expect(p.tenantId).toBe(staff.tenantId);
    expect(p.permissions).toEqual([]);
  });

  it('maps granted actions to slugs, never the owner slug, delete or methods', async () => {
    await wipe();
    const d = def('Chore', 'Note');
    await asOwner(async () => {
      await ModelAccessGrant.grant(d, 'Chore', 'read');
      await ModelAccessGrant.grant(d, 'Chore', 'update');
      await ModelAccessGrant.grant(d, 'Note', 'create');
    });
    for (const role of [DEFAULT_ROLE_SLUGS.ADMIN, DEFAULT_ROLE_SLUGS.MEMBER]) {
      const staff = await staffAs(role);
      const p = await staffPrincipalFor(staff, staff.tenantId, d);
      expect([...p.permissions].sort()).toEqual(
        [
          'u_chores.list',
          'u_chores.get',
          'u_chores.count',
          'u_chores.update',
          'u_notes.create',
        ].sort(),
      );
      expect(p.permissions).not.toContain(OWNER_SLUG);
      expect(p.permissions.some((s) => s.endsWith('.delete'))).toBe(false);
    }
  });

  it('caps a viewer at read whatever the grant says', async () => {
    await wipe();
    const d = def('Chore');
    await asOwner(async () => {
      await ModelAccessGrant.grant(d, 'Chore', 'read');
      await ModelAccessGrant.grant(d, 'Chore', 'create');
      await ModelAccessGrant.grant(d, 'Chore', 'update');
    });
    const viewer = await staffAs(DEFAULT_ROLE_SLUGS.VIEWER);
    const p = await staffPrincipalFor(viewer, viewer.tenantId, d);
    expect([...p.permissions].sort()).toEqual([
      'u_chores.count',
      'u_chores.get',
      'u_chores.list',
    ]);
  });

  it('is empty for the owner, an inactive member, a stranger and another tenant', async () => {
    await wipe();
    const d = def('Chore');
    await asOwner(() => ModelAccessGrant.grant(d, 'Chore', 'read'));
    expect(
      (await staffPrincipalFor(h.owner, h.owner.tenantId, d)).permissions,
    ).toEqual([]);
    for (const status of [
      MembershipStatus.INACTIVE,
      MembershipStatus.PENDING,
    ]) {
      const gone = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER, status);
      expect(
        (await staffPrincipalFor(gone, gone.tenantId, d)).permissions,
      ).toEqual([]);
    }
    expect(
      (await staffPrincipalFor(h.stranger, h.stranger.tenantId, d)).permissions,
    ).toEqual([]);
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    expect(
      (await staffPrincipalFor(staff, 'another-tenant', d)).permissions,
    ).toEqual([]);
  });

  it('ignores a grant whose model is gone or is a different model of the same name', async () => {
    await wipe();
    const d = def('Chore');
    await asOwner(() => ModelAccessGrant.grant(d, 'Chore', 'read'));
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    expect(
      (await staffPrincipalFor(staff, staff.tenantId, def('Other')))
        .permissions,
    ).toEqual([]);
    const reborn = {
      ...d,
      models: { Chore: { extends: 'x:Y', fields: {} } },
    } as unknown as AppDefinition;
    expect(
      (await staffPrincipalFor(staff, staff.tenantId, reborn)).permissions,
    ).toEqual([]);
  });
});

describe('callerOf', () => {
  const event = (who: Principal | null, method = 'GET', origin = false) =>
    ({
      request: new Request('http://localhost:5173/x', {
        method,
        headers: origin ? { origin: 'http://localhost:5173' } : {},
      }),
      url: new URL('http://localhost:5173/x'),
      locals: who
        ? { user: { id: who.id }, tenantId: who.tenantId, permissions: [] }
        : {},
    }) as never;

  it('says owner, staff, or refuses (401 nobody, 403 anyone else)', async () => {
    expect(await callerOf(event(h.owner))).toEqual({
      kind: 'owner',
      principal: expect.objectContaining({ id: h.owner.id }),
    });
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    expect(await callerOf(event(staff))).toMatchObject({ kind: 'staff' });
    await expect(callerOf(event(null))).rejects.toMatchObject({ status: 401 });
    await expect(callerOf(event(h.stranger))).rejects.toMatchObject({
      status: 403,
    });
    const gone = await staffAs(
      DEFAULT_ROLE_SLUGS.MEMBER,
      MembershipStatus.INACTIVE,
    );
    await expect(callerOf(event(gone))).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a cross-origin write like ownerOf', async () => {
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    const cross = {
      ...(event(staff, 'POST') as object),
      request: new Request('http://localhost:5173/x', {
        method: 'POST',
        headers: { origin: 'http://evil.test' },
      }),
    } as never;
    await expect(callerOf(cross)).rejects.toMatchObject({ status: 403 });
    expect(await callerOf(event(staff, 'POST', true))).toMatchObject({
      kind: 'staff',
    });
  });
});

describe('grants leave with their model', () => {
  const record = (version: number, d: AppDefinition): VersionRecord => ({
    version,
    parent: version === 0 ? null : version - 1,
    author: 'test',
    summary: `v${version}`,
    definition: d,
    migration: null,
    createdAt: new Date().toISOString(),
  });
  const models = async () => (await rows()).map((r) => r.modelName).sort();

  it('clears on removal, on undo past the model, and on import into an empty app', async () => {
    await wipe();
    const store = new ShellVersionStore(h.db);
    const v0 = def('Chore');
    const v1 = def('Chore', 'Note');
    const v2 = def('Chore');
    await runAs(h.owner, async () => {
      await store.commit([record(0, v0)], 0);
      await store.commit([record(1, v1)], 1);
    });
    await asOwner(async () => {
      await ModelAccessGrant.grant(v1, 'Chore', 'read');
      await ModelAccessGrant.grant(v1, 'Note', 'read');
    });
    // remove Note: only its grants go
    await runAs(h.owner, () => store.commit([record(2, v2)], 2));
    expect(await models()).toEqual(['Chore']);
    // undo to v1 puts Note back, closed
    await runAs(h.owner, () => store.setCurrent(1));
    expect(await models()).toEqual(['Chore']);
    await asOwner(() => ModelAccessGrant.grant(v1, 'Note', 'update'));
    expect(await models()).toEqual(['Chore', 'Note']);
    // undo-to v0 (before Note existed) clears it again
    await runAs(h.owner, () => store.setCurrent(0));
    expect(await models()).toEqual(['Chore']);
    // a first commit into an empty app (import) starts everything closed
    await clearGrants(h.db, null, '', JSON.stringify(v0));
    expect(await models()).toEqual([]);
  });

  it('a new model of an old name starts closed for staff', async () => {
    await wipe();
    const store = new ShellVersionStore(h.db);
    const withChore = def('Chore');
    await runAs(h.owner, () => store.commit([record(10, withChore)], 10));
    await asOwner(() => ModelAccessGrant.grant(withChore, 'Chore', 'read'));
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    expect(
      (await staffPrincipalFor(staff, staff.tenantId, withChore)).permissions,
    ).not.toEqual([]);
    await runAs(h.owner, () => store.commit([record(11, def())], 11));
    await runAs(h.owner, () => store.commit([record(12, withChore)], 12));
    expect(
      (await staffPrincipalFor(staff, staff.tenantId, withChore)).permissions,
    ).toEqual([]);
  });
});
