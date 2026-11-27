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
import { finalStaffSlugs } from './model-access.ts';
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

const store = () => new ShellVersionStore(h.db, h.owner.tenantId);
let nextVersion = 100;
/** Make `d` the stored current definition (a new version on the current one). */
const setDef = async (d: AppDefinition): Promise<AppDefinition> => {
  const s = store();
  const parent = await runAs(h.owner, () => s.current());
  const version = nextVersion++;
  await runAs(h.owner, () =>
    s.commit(
      [
        {
          version,
          parent,
          author: 'test',
          summary: `v${version}`,
          definition: d,
          migration: null,
          createdAt: new Date().toISOString(),
        },
      ],
      version,
    ),
  );
  return d;
};

const asOwner = <T>(fn: () => Promise<T>) => runAs(h.owner, fn);
const rows = () =>
  asOwner(async () =>
    (await ModelAccessGrantCollection.create({ db: h.db })).list({
      limit: 100,
    }),
  );
const wipe = () => h.db.query('DELETE FROM model_access_grants');

describe('create and update need read (they return the record)', () => {
  it('refuses create and update until read is held; revoking read revokes them', async () => {
    await wipe();
    await setDef(def('Chore'));
    for (const action of ['create', 'update'])
      await expect(
        asOwner(() => ModelAccessGrant.grant('Chore', action)),
      ).rejects.toThrow(/grant read/);
    expect(await rows()).toHaveLength(0);
    await asOwner(async () => {
      await ModelAccessGrant.grant('Chore', 'read');
      await ModelAccessGrant.grant('Chore', 'create');
      await ModelAccessGrant.grant('Chore', 'update');
    });
    expect(await rows()).toHaveLength(3);
    expect(await asOwner(() => ModelAccessGrant.revoke('Chore', 'read'))).toBe(
      true,
    );
    expect(await rows()).toHaveLength(0);
  });

  it('a stored write grant without read mints no slug at all', async () => {
    await wipe();
    const d = await setDef(def('Chore'));
    await asOwner(() => ModelAccessGrant.grant('Chore', 'read'));
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    // a stray update row (written around the API) with the read row gone
    await asOwner(() => ModelAccessGrant.grant('Chore', 'update'));
    await h.db.query("DELETE FROM model_access_grants WHERE action = 'read'");
    expect(
      (await staffPrincipalFor(staff, staff.tenantId, d)).permissions,
    ).toEqual([]);
  });

  it('finalStaffSlugs drops create and update without the list and get slugs', () => {
    const d = def('Chore');
    expect(
      finalStaffSlugs(d, [
        'u_chores.update',
        'u_chores.create',
        'u_chores.list',
      ]),
    ).toEqual(['u_chores.list']);
    expect(
      finalStaffSlugs(d, [
        'u_chores.update',
        'u_chores.list',
        'u_chores.get',
      ]).sort(),
    ).toEqual(['u_chores.get', 'u_chores.list', 'u_chores.update']);
  });
});

describe('ModelAccessGrant', () => {
  it('is owner only and idempotent per tenant + model + action', async () => {
    await wipe();
    const d = await setDef(def('Chore'));
    await expect(
      runAs(h.member, () => ModelAccessGrant.grant('Chore', 'read')),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runAs(h.member, () => ModelAccessGrant.list()),
    ).rejects.toMatchObject({ status: 403 });
    await asOwner(() => ModelAccessGrant.grant('Chore', 'read'));
    await asOwner(() => ModelAccessGrant.grant('Chore', 'read'));
    await asOwner(() => ModelAccessGrant.grant('Chore', 'create'));
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
    // revoking read took create with it
    expect(await rows()).toHaveLength(0);
  });

  it('refuses delete, method slugs and unknown models or actions', async () => {
    await wipe();
    const d = await setDef(def('Chore'));
    for (const action of [
      'delete',
      'list',
      'get',
      'Chore.markDone',
      'u_chores.delete',
      '',
    ])
      await expect(
        asOwner(() => ModelAccessGrant.grant('Chore', action)),
      ).rejects.toThrow(/cannot be granted/);
    await expect(
      asOwner(() => ModelAccessGrant.grant('Nope', 'read')),
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
    const d = await setDef(def('Chore', 'Note'));
    await asOwner(async () => {
      await ModelAccessGrant.grant('Chore', 'read');
      await ModelAccessGrant.grant('Chore', 'update');
      await ModelAccessGrant.grant('Note', 'read');
      await ModelAccessGrant.grant('Note', 'create');
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
          'u_notes.list',
          'u_notes.get',
          'u_notes.count',
          'u_notes.create',
        ].sort(),
      );
      expect(p.permissions).not.toContain(OWNER_SLUG);
      expect(p.permissions.some((s) => s.endsWith('.delete'))).toBe(false);
    }
  });

  it('caps a viewer at read whatever the grant says', async () => {
    await wipe();
    const d = await setDef(def('Chore'));
    await asOwner(async () => {
      await ModelAccessGrant.grant('Chore', 'read');
      await ModelAccessGrant.grant('Chore', 'create');
      await ModelAccessGrant.grant('Chore', 'update');
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
    const d = await setDef(def('Chore'));
    await asOwner(() => ModelAccessGrant.grant('Chore', 'read'));
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
    const d = await setDef(def('Chore'));
    await asOwner(() => ModelAccessGrant.grant('Chore', 'read'));
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    expect(
      (await staffPrincipalFor(staff, staff.tenantId, def('Other')))
        .permissions,
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
  const models = async () => (await rows()).map((r) => r.modelName).sort();
  const record = (
    version: number,
    parent: number | null,
    d: AppDefinition,
    summary = `v${version}`,
  ): VersionRecord => ({
    version,
    parent,
    author: 'test',
    summary,
    definition: d,
    migration: null,
    createdAt: new Date().toISOString(),
  });

  it('clears on removal and on undo past the model, but only that model', async () => {
    await wipe();
    const s = store();
    const v0 = await setDef(def('Chore'));
    const base = nextVersion - 1;
    const v1 = def('Chore', 'Note');
    await runAs(h.owner, () =>
      s.commit([record(nextVersion, base, v1)], nextVersion),
    );
    const added = nextVersion++;
    await asOwner(async () => {
      await ModelAccessGrant.grant('Chore', 'read');
      await ModelAccessGrant.grant('Note', 'read');
    });
    // remove Note
    await runAs(h.owner, () =>
      s.commit([record(nextVersion, added, v0)], nextVersion),
    );
    nextVersion++;
    expect(await models()).toEqual(['Chore']);
    // undo to the version that had Note: it is back, and closed
    await runAs(h.owner, () => s.setCurrent(added));
    expect(await models()).toEqual(['Chore']);
    await asOwner(() => ModelAccessGrant.grant('Note', 'read'));
    expect(await models()).toEqual(['Chore', 'Note']);
    // undo-to before Note existed clears it again
    await runAs(h.owner, () => s.setCurrent(base));
    expect(await models()).toEqual(['Chore']);
  });

  it('a new model of an old name starts closed for staff', async () => {
    await wipe();
    const d = await setDef(def('Chore'));
    await asOwner(() => ModelAccessGrant.grant('Chore', 'read'));
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    const slugs = async () =>
      (await staffPrincipalFor(staff, staff.tenantId, d)).permissions;
    expect(await slugs()).not.toEqual([]);
    await setDef(def());
    await setDef(d);
    expect(await slugs()).toEqual([]);
    // and a grant that survived by some other path still does not match the new stamp
    await asOwner(() => ModelAccessGrant.grant('Chore', 'read'));
    await h.db.query("UPDATE model_access_grants SET model_stamp = 'old'");
    expect(await slugs()).toEqual([]);
  });

  it('an import published from a draft clears every grant', async () => {
    await wipe();
    await setDef(def());
    const parent = nextVersion - 1;
    await h.db.query(
      "INSERT INTO model_access_grants (id, slug, tenant_id, model_name, model_stamp, action, granted_by) VALUES ('33333333-3333-4333-8333-333333333333', 'z', ?, 'Chore', 'old', 'read', 'o')",
      h.owner.tenantId,
    );
    const v = nextVersion++;
    await runAs(h.owner, () =>
      store().commit(
        [record(v, parent, def('Chore'), '[draft: Plan] import template')],
        v,
      ),
    );
    expect(await models()).toEqual([]);
  });
});

describe('remove and recreate in one publish', () => {
  it('drops the grants and leaves the replacement closed', async () => {
    await wipe();
    const d = await setDef(def('Chore'));
    await asOwner(() => ModelAccessGrant.grant('Chore', 'read'));
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    const parent = nextVersion - 1;
    const mk = (version: number, p: number, definition: AppDefinition) => ({
      version,
      parent: p,
      author: 'test',
      summary: `v${version}`,
      definition,
      migration: null,
      createdAt: new Date().toISOString(),
    });
    const a = nextVersion++;
    const b = nextVersion++;
    await runAs(h.owner, () =>
      store().commit([mk(a, parent, def()), mk(b, a, d)], b),
    );
    expect(await rows()).toHaveLength(0);
    expect(
      (await staffPrincipalFor(staff, staff.tenantId, d)).permissions,
    ).toEqual([]);
  });

  it('even if a row survived, the new creation stamp makes it inert', async () => {
    await wipe();
    const d = await setDef(def('Chore'));
    await asOwner(() => ModelAccessGrant.grant('Chore', 'read'));
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    const [original] = await rows();
    await setDef(def());
    await setDef(d);
    // the old row, put back as it was (same stamp): only the stamp keeps it inert
    await h.db.query(
      "INSERT INTO model_access_grants (id, slug, tenant_id, model_name, model_stamp, action, granted_by) VALUES ('22222222-2222-4222-8222-222222222222', 'y', ?, 'Chore', ?, 'read', 'o')",
      h.owner.tenantId,
      original.modelStamp,
    );
    expect(await rows()).toHaveLength(1);
    expect(
      (await staffPrincipalFor(staff, staff.tenantId, d)).permissions,
    ).toEqual([]);
  });
});

describe('slug safety', () => {
  it('refuses a grant on a model that shares its table, and never emits its slugs', async () => {
    await wipe();
    const d = await setDef(def('Chore', 'Chores'));
    await expect(
      asOwner(() => ModelAccessGrant.grant('Chore', 'read')),
    ).rejects.toThrow(/shares its table/);
    // a row that got in by another path opens neither model
    await h.db.query(
      "INSERT INTO model_access_grants (id, slug, tenant_id, model_name, model_stamp, action, granted_by) VALUES ('11111111-1111-4111-8111-111111111111', 'x', ?, 'Chore', 'x', 'read', 'o')",
      h.owner.tenantId,
    );
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    expect(
      (await staffPrincipalFor(staff, staff.tenantId, d)).permissions,
    ).toEqual([]);
  });

  it('the final filter strips the owner slug and anything outside the action map', () => {
    const d = def('Chore');
    expect(
      finalStaffSlugs(d, [
        OWNER_SLUG,
        'u_chores.list',
        'u_chores.delete',
        'u_chores.markDone',
        'u_other.get',
        '*',
      ]),
    ).toEqual(['u_chores.list']);
  });
});

describe('unstage back to no version (#5197)', () => {
  it('clears every grant, so a same-named model or a reused version number gets none', async () => {
    await wipe();
    // The harness stores rows with no tenant (the desktop's one owner), so the
    // store names none either, as it does there.
    const s = new ShellVersionStore(h.db, null);
    const commitAt = async (version: number, d: AppDefinition) => {
      const parent = await runAs(h.owner, () => s.current());
      await runAs(h.owner, () =>
        s.commit(
          [
            {
              version,
              parent,
              author: 'test',
              summary: `v${version}`,
              definition: d,
              migration: null,
              createdAt: new Date().toISOString(),
            },
          ],
          version,
        ),
      );
    };
    const first = nextVersion++;
    await commitAt(first, def('Chore'));
    await asOwner(() => ModelAccessGrant.grant('Chore', 'read'));
    expect(await rows()).toHaveLength(1);
    await runAs(h.owner, () => s.unstage([first], null));
    expect(await rows()).toHaveLength(0);
    // the same name again, at the very version number that was unstaged
    const again = def('Chore');
    await commitAt(first, again);
    const staff = await staffAs(DEFAULT_ROLE_SLUGS.MEMBER);
    expect(await rows()).toHaveLength(0);
    expect(
      (await staffPrincipalFor(staff, staff.tenantId, again)).permissions,
    ).toEqual([]);
    // a failed unstage rolls back with its grants
    await asOwner(() => ModelAccessGrant.grant('Chore', 'read'));
    await expect(
      runAs(h.owner, () => s.unstage([first], -12345)),
    ).rejects.toThrow();
    expect(await rows()).toHaveLength(1);
  });
});
