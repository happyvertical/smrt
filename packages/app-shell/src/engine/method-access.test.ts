// A method acts as its caller (#5197 s2): it reads only if the caller may read
// every model, writes only to models the caller may write, and a refusal never
// tells whether a record exists in a model the caller cannot see.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import {
  AppHost,
  type Command,
  enginePrincipal,
  MemoryVersionStore,
} from './index.ts';
import { slugFor } from './permissions.ts';

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
    `app.update('Secret', params.id, { note: 'changed' }); return 1;`,
    { id: { type: 'text', required: true } },
  );
  await add(
    'link',
    `app.create('Chore', { title: 'l', secret: params.id }); return 1;`,
    { id: { type: 'text', required: true } },
  );
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
    expect(e.message).toMatch(/may not read Secret/);
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
        host.runMethod(readsAll(), 'Chore', 'touch', null, { id: secretId }),
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
    await host.runMethod(owner, 'Chore', 'touch', null, { id: secretId });
    expect((await host.list(owner, 'Secret'))[0].note).toBe('changed');
    await host.update(owner, 'Secret', secretId, { note: 'hidden' });
  });

  it('gives no existence probe across ungranted models', async () => {
    const p = readsAll();
    const real = await host
      .runMethod(p, 'Chore', 'touch', null, { id: secretId })
      .catch((x) => x);
    const fake = await host
      .runMethod(p, 'Chore', 'touch', null, { id: 'no-such-id' })
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
    const p = choreOnly();
    const tool = await host
      .callAppTool(p, 'chore_peek', { id: choreId })
      .catch((x) => x);
    expect(tool.isError === true || tool instanceof Error).toBe(true);
    expect(await count('Chore')).toBe(1);
    const secret = await host
      .callAppTool(readsAll(), 'chore_addSecret', { id: choreId })
      .catch((x) => x);
    expect(secret.isError === true || secret instanceof Error).toBe(true);
    const liveTool = await host.callAppTool(readsAll(), 'chore_peek', {
      id: choreId,
    });
    expect(liveTool.isError).toBe(false);
    expect(await count('Secret')).toBe(1);
  });
});
