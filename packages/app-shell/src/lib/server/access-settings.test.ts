// Owner control of staff model access (#5197 S5). In-process: SQLite shell.db
// and a real live host; the route modules are called directly.
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GET as accessGET,
  PUT as accessPUT,
} from '../../routes/api/shell/access/+server.ts';
import { load as accessPage } from '../../routes/settings/access/+page.server.ts';
import { can } from '../ui/access.ts';
import { runCommand } from './builder.ts';
import type { Principal } from './owner.ts';
import { staffDescription } from './staff-access.ts';
import {
  applyWaiting,
  openShell,
  runAs,
  type ShellHarness,
} from './test-support.ts';

let h: ShellHarness;
let staff: Principal;

function ev(who: Principal | null, method = 'GET', body?: unknown) {
  const url = new URL('http://localhost/api/shell/access');
  return {
    url,
    params: {},
    request: new Request(url, {
      method,
      headers: { origin: url.origin, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    locals: who
      ? { user: { id: who.id }, tenantId: who.tenantId, permissions: [] }
      : { user: null, tenantId: null },
  } as never;
}
const put = (who: Principal | null, body: unknown) =>
  accessPUT(ev(who, 'PUT', body));
type Row = {
  model: string;
  grantable: boolean;
  read: boolean;
  create: boolean;
  update: boolean;
};
async function rows(who: Principal | null = h.owner): Promise<Row[]> {
  const r = await accessGET(ev(who));
  expect(r.status).toBe(200);
  return ((await r.json()) as { models: Row[] }).models;
}
const row = async (model: string) =>
  (await rows()).find((r) => r.model === model) as Row;

beforeAll(async () => {
  h = await openShell();
  await runAs(h.owner, async () => {
    for (const name of ['Chore', 'Secret'])
      await runCommand(
        {
          type: 'defineModel',
          name,
          fields: { title: { type: 'text' } },
        },
        h.owner,
        'live',
      );
  });
  await applyWaiting(h.owner);
  const users = await UserCollection.create({ db: h.db });
  const user = await users.create({ email: 'st@x.test', username: 'st' });
  await user.save();
  const role = await (
    await RoleCollection.create({ db: h.db })
  ).findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.MEMBER);
  const m = await (await MembershipCollection.create({ db: h.db })).create({
    userId: user.id as string,
    tenantId: h.owner.tenantId,
    roleId: role?.id as string,
    status: MembershipStatus.ACTIVE,
  });
  await m.save();
  staff = { id: user.id as string, tenantId: h.owner.tenantId } as Principal;
});
afterAll(async () => {
  await h.close();
});

describe('owner control of staff access', () => {
  it('starts closed and lists every model', async () => {
    const all = await rows();
    expect(all.map((r) => r.model).sort()).toEqual(['Chore', 'Secret']);
    for (const r of all)
      expect([r.grantable, r.read, r.create, r.update]).toEqual([
        true,
        false,
        false,
        false,
      ]);
  });

  it('the owner sets and clears read, create and update', async () => {
    const set = (action: string, allowed: boolean) =>
      put(h.owner, { model: 'Chore', action, allowed });
    expect((await set('read', true)).status).toBe(200);
    expect((await set('create', true)).status).toBe(200);
    expect((await set('update', true)).status).toBe(200);
    expect(await row('Chore')).toMatchObject({
      read: true,
      create: true,
      update: true,
    });
    expect(await row('Secret')).toMatchObject({ read: false });
    expect((await set('update', false)).status).toBe(200);
    expect(await row('Chore')).toMatchObject({ create: true, update: false });
    // taking read back takes create with it
    expect((await set('read', false)).status).toBe(200);
    expect(await row('Chore')).toMatchObject({
      read: false,
      create: false,
      update: false,
    });
  });

  it('create and update need read; delete and unknown actions are never grantable', async () => {
    for (const action of ['create', 'update']) {
      const r = await put(h.owner, { model: 'Secret', action, allowed: true });
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toMatch(/read/);
    }
    for (const action of ['delete', 'Chore.delete', 'app_x', '']) {
      const r = await put(h.owner, { model: 'Chore', action, allowed: true });
      expect(r.status).toBe(409);
      // clearing one is refused the same way
      expect(
        (await put(h.owner, { model: 'Chore', action, allowed: false })).status,
      ).toBe(409);
    }
    expect(await row('Secret')).toMatchObject({
      read: false,
      create: false,
      update: false,
    });
  });

  it('bad bodies and unknown models are refused', async () => {
    for (const body of [
      {},
      { model: 'Chore', action: 'read' },
      { model: 'Chore', action: 'read', allowed: 'yes' },
      { model: 1, action: 'read', allowed: true },
      { model: 'Chore', action: 'read', allowed: true, extra: 1 },
    ])
      expect((await put(h.owner, body)).status).toBe(400);
    expect(
      (await put(h.owner, { model: 'Nope', action: 'read', allowed: true }))
        .status,
    ).toBe(404);
  });

  it('staff, outsiders and nobody are refused, and change nothing', async () => {
    const body = { model: 'Secret', action: 'read', allowed: true };
    for (const [who, status] of [
      [staff, 403],
      [h.stranger, 403],
      [null, 401],
    ] as const) {
      expect((await accessGET(ev(who))).status).toBe(status);
      expect((await put(who, body)).status).toBe(status);
      await expect(
        (accessPage as unknown as (e: unknown) => Promise<unknown>)(ev(who)),
      ).rejects.toBeTruthy();
    }
    expect(await row('Secret')).toMatchObject({ read: false });
  });

  it('a write from a foreign origin is refused and changes nothing', async () => {
    const url = new URL('http://localhost/api/shell/access');
    const foreign = {
      url,
      params: {},
      request: new Request(url, {
        method: 'PUT',
        headers: {
          origin: 'http://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'Secret',
          action: 'read',
          allowed: true,
        }),
      }),
      locals: {
        user: { id: h.owner.id },
        tenantId: h.owner.tenantId,
        permissions: [],
      },
    } as never;
    expect((await accessPUT(foreign)).status).toBe(403);
    expect(await row('Secret')).toMatchObject({ read: false });
  });

  it('staff see only their own allowed actions, and the UI helper follows them', async () => {
    await put(h.owner, { model: 'Chore', action: 'read', allowed: true });
    await put(h.owner, { model: 'Chore', action: 'create', allowed: true });
    const d = await staffDescription(staff);
    expect(d.access).toEqual({
      Chore: { read: true, create: true, update: false },
    });
    expect(can(d, 'Chore', 'create')).toBe(true);
    expect(can(d, 'Chore', 'update')).toBe(false);
    expect(can(d, 'Chore', 'delete')).toBe(false);
    expect(can(d, 'Secret', 'create')).toBe(false);
    // the owner (no staff marker) may do everything
    expect(can({ staff: undefined }, 'Chore', 'update')).toBe(true);
  });
});

describe('recipe-backed models', () => {
  it('lists app subclasses of shipped models; one sharing a table stays closed', async () => {
    await runAs(h.owner, async () => {
      await runCommand(
        { type: 'enableRecipe', recipe: 'profiles' },
        h.owner,
        'live',
      );
    });
    await applyWaiting(h.owner);
    const host = await (await import('./host.ts')).hostFor('live');
    const sub = Object.entries(host.describe().models).filter(
      ([, i]) => i.kind === 'shipped-subclass',
    );
    expect(sub.length).toBeGreaterThan(0);
    const all = await rows();
    const shared = (await import('./model-access.ts')).sharedTableModels(
      host.def,
    );
    for (const [name] of sub) {
      const r = all.find((x) => x.model === name);
      expect(r, name).toBeDefined();
      expect(r?.grantable).toBe(!shared.has(name));
    }
  });
});
