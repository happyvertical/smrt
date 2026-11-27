// A method acts as its caller (#5197 s2): it reads only if the caller may read
// every model, writes only to models the caller may write, and a refusal never
// tells whether a record exists in a model the caller cannot see.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import { NoPrincipalError, PermissionDeniedError } from './errors.ts';
import {
  AppHost,
  type Command,
  enginePrincipal,
  MemoryVersionStore,
} from './index.ts';
import { slugFor } from './permissions.ts';
import { mintSystemPrincipal } from './principal.ts';

const dir = mkdtempSync(join(tmpdir(), 'engine-method-access-'));
let host: AppHost;
const TENANT = '00000000-0000-4000-8000-0000000000b1';
const user = (userId: string, permissions: string[]) =>
  enginePrincipal({ kind: 'user', tenantId: TENANT, userId, permissions });
const slug = (model: string, action: string) =>
  slugFor(host.def, model, action);

let secretId = '';
let choreId = '';

beforeAll(async () => {
  host = await AppHost.open(dir, {
    store: new MemoryVersionStore(),
    tenantId: TENANT,
  });
  const run = (command: Command) =>
    host.execute(hostOwner(host), command, { author: 't', approved: true });
  await run({
    type: 'defineModel',
    name: 'Secret',
    fields: { note: { type: 'text' } },
  });
  await run({
    type: 'defineModel',
    name: 'Chore',
    fields: {
      title: { type: 'text' },
      secret: { type: 'reference', ref: 'Secret' },
    },
  });
  const add = (name: string, code: string, params?: object) =>
    run({
      type: 'addMethod',
      model: 'Chore',
      name,
      method: { description: name, code, ...(params ? { params } : {}) },
    } as Command);
  await add('peek', 'return data.Secret.length + data.Chore.length;');
  await add('addChore', `app.create('Chore', { title: 'made' }); return 1;`);
  await add('addSecret', `app.create('Secret', { note: 'x' }); return 1;`);
  await add(
    'touch',
    `app.update('Secret', params.target, { note: 'changed' }); return 1;`,
    { target: { type: 'text', required: true } },
  );
  await add(
    'link',
    `app.create('Chore', { title: 'l', secret: params.id }); return 1;`,
    { id: { type: 'text', required: true } },
  );
  await add('wipe', `app.delete('Chore', params.id); return 1;`, {
    id: { type: 'text', required: true },
  });
  secretId = String(
    (await host.create(hostOwner(host), 'Secret', { note: 'hidden' })).id,
  );
  choreId = String(
    (await host.create(hostOwner(host), 'Chore', { title: 'kept' })).id,
  );
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const method = (name: string) => slug('Chore', name);
const choreOnly = (...extra: string[]) =>
  user('staff', [
    slug('Chore', 'list'),
    slug('Chore', 'get'),
    slug('Chore', 'create'),
    ...['peek', 'addChore', 'addSecret', 'touch', 'link'].map(method),
    ...extra,
  ]);
const readsAll = (...extra: string[]) =>
  choreOnly(slug('Secret', 'list'), slug('Secret', 'get'), ...extra);
const count = async (m: string) => (await host.list(hostOwner(host), m)).length;

describe('a method acts as its caller', () => {
  it('cannot read a model the caller may not read, and nothing runs', async () => {
    const e = await host
      .runMethod(choreOnly(), 'Chore', 'peek')
      .catch((x) => x);
    expect(e).toMatchObject({ code: 'forbidden' });
    expect(e).toBeInstanceOf(PermissionDeniedError);
    expect(e.message).toBe(
      'permission denied: you may not run this method; nothing ran',
    );
    expect(e.message).not.toMatch(/Secret/);
    expect(await count('Chore')).toBe(1);
    // Granted: it runs.
    const ok = await host.runMethod(readsAll(), 'Chore', 'peek');
    expect(ok.result).toBe(2);
  });

  it('cannot write a model the caller may not write', async () => {
    const before = await count('Secret');
    for (const attempt of [
      () => host.runMethod(readsAll(), 'Chore', 'addSecret'),
      () =>
        host.runMethod(readsAll(), 'Chore', 'touch', null, {
          target: secretId,
        }),
    ])
      await expect(attempt()).rejects.toMatchObject({ code: 'forbidden' });
    expect(await count('Secret')).toBe(before);
    expect((await host.list(hostOwner(host), 'Secret'))[0].note).toBe('hidden');
  });

  it('own-model writes still work with their grants', async () => {
    const r = await host.runMethod(readsAll(), 'Chore', 'addChore');
    expect(r.applied).toBe(1);
    expect(await count('Chore')).toBe(2);
    // Cleanup for later tests.
    for (const row of await host.list(hostOwner(host), 'Chore'))
      if (row.title === 'made')
        await host.remove(hostOwner(host), 'Chore', String(row.id));
  });

  it('owner is unchanged: reads and writes every model', async () => {
    const owner = hostOwner(host);
    expect(
      (await host.runMethod(owner, 'Chore', 'peek')).result,
    ).toBeGreaterThan(0);
    await host.runMethod(owner, 'Chore', 'touch', null, { target: secretId });
    expect((await host.list(owner, 'Secret'))[0].note).toBe('changed');
    await host.update(owner, 'Secret', secretId, { note: 'hidden' });
  });

  it('gives no existence probe across ungranted models', async () => {
    const p = readsAll();
    const real = await host
      .runMethod(p, 'Chore', 'touch', null, { target: secretId })
      .catch((x) => x);
    const fake = await host
      .runMethod(p, 'Chore', 'touch', null, { target: 'no-such-id' })
      .catch((x) => x);
    expect(real.message).toBe(fake.message);
  });

  it('a reference to an ungranted record reads like a missing one', async () => {
    const p = user('w', [slug('Chore', 'create'), slug('Chore', 'list')]);
    const real = await host
      .create(p, 'Chore', { title: 'x', secret: secretId })
      .catch((x) => x);
    const fake = await host
      .create(p, 'Chore', { title: 'x', secret: 'no-such-id' })
      .catch((x) => x);
    expect(real).toBeInstanceOf(Error);
    expect(real.message.replace(secretId, 'ID')).toBe(
      fake.message.replace('no-such-id', 'ID'),
    );
    expect(await count('Chore')).toBe(1);
  });

  it('is enforced on the MCP method tool', async () => {
    const rowsBefore = JSON.stringify(
      await host.list(hostOwner(host), 'Secret'),
    );
    const chores = await count('Chore');
    // Method read refused: the tool answers with the permission-denied error.
    const read = await host
      .callAppTool(choreOnly(), 'chore_peek', { id: choreId })
      .catch((x) => x);
    const text = JSON.stringify(read);
    expect(text).toMatch(/permission denied|forbidden/i);
    expect(text).not.toMatch(/Secret/);
    expect(read instanceof Error || read.isError === true).toBe(true);
    // Write refused: the Secret table is unchanged because of the refusal.
    const names = (await host.appTools(hostOwner(host))).map((t) => t.name);
    expect(names).toContain('chore_touch');
    const write = await host
      .callAppTool(readsAll(), 'chore_touch', { id: choreId, target: secretId })
      .catch((x) => x);
    expect(JSON.stringify(write)).toMatch(/permission denied|forbidden/i);
    expect(JSON.stringify(await host.list(hostOwner(host), 'Secret'))).toBe(
      rowsBefore,
    );
    expect(await count('Chore')).toBe(chores);
    // The same tool is live for a caller with the grants.
    const live = await host.callAppTool(readsAll(), 'chore_peek', {
      id: choreId,
    });
    expect(live.isError).toBe(false);
  });

  it('the REST custom-action route does not exist: /api/<model>/<x> is a record route', async () => {
    // restRouteAllowed admits at most two path parts, and a second part is a
    // record id, so a method has no REST route here (POST /api/chores/peek is
    // a create). Methods reach callers through the MCP tool and runMethod.
    const before = await count('Chore');
    const r = await host.rest(choreOnly(), {
      method: 'POST',
      url: '/api/chores/peek',
    });
    expect(r.status).toBe(201);
    expect(await count('Chore')).toBe(before + 1);
    for (const row of await host.list(hostOwner(host), 'Chore'))
      if (row.id !== choreId)
        await host.remove(hostOwner(host), 'Chore', String(row.id));
  });

  it('system and owner run methods, with or without a scope', async () => {
    const sys = mintSystemPrincipal(TENANT);
    expect((await host.runMethod(sys, 'Chore', 'peek')).result).toBeGreaterThan(
      0,
    );
    expect(
      (await host.runMethod(hostOwner(host), 'Chore', 'peek')).result,
    ).toBeGreaterThan(0);
    // No principal at all is refused, not run as the engine.
    for (const none of [undefined, null])
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: no caller on purpose
        host.runMethod(none as any, 'Chore', 'peek'),
      ).rejects.toBeInstanceOf(NoPrincipalError);
  });

  it('delete writes need the delete slug, and succeed (re-checked in the transaction) with it', async () => {
    const owner = hostOwner(host);
    await host.update(owner, 'Chore', choreId, { title: 'kept' });
    const doomed = String(
      (await host.create(owner, 'Chore', { title: 'doomed' })).id,
    );
    const noDelete = readsAll(method('wipe'));
    await expect(
      host.runMethod(noDelete, 'Chore', 'wipe', null, { id: doomed }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await count('Chore')).toBe(2);
    const withDelete = readsAll(method('wipe'), slug('Chore', 'delete'));
    const r = await host.runMethod(withDelete, 'Chore', 'wipe', null, {
      id: doomed,
    });
    expect(r.applied).toBe(1);
    expect(await count('Chore')).toBe(1);
  });
});
