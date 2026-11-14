import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  AppHost,
  ApprovalRequiredError,
  type Command,
  MemoryVersionStore,
} from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'merge-4916-'));
const store = new MemoryVersionStore();
let host: AppHost;
const run = (cmd: Command) =>
  host.execute(cmd, { author: 't', approved: true });
let keep = '';
let other = '';
const raw = () => {
  const db = new DatabaseSync(join(dir, 'app.db'));
  try {
    return ['u_customers', 'u_notes', 'u_tasks'].map((t) =>
      db.prepare(`SELECT * FROM ${t} ORDER BY id`).all(),
    );
  } finally {
    db.close();
  }
};
beforeAll(async () => {
  host = await AppHost.open(dir, { store });
  await run({
    type: 'defineModel',
    name: 'Customer',
    fields: { name: { type: 'text' }, email: { type: 'text' } },
  });
  keep = String(
    (await host.create('Customer', { name: 'Ada', email: null })).id,
  );
  other = String(
    (await host.create('Customer', { name: 'A', email: 'ada@example.test' }))
      .id,
  );
  for (const name of ['Note', 'Task']) {
    await run({
      type: 'defineModel',
      name,
      fields: {
        customer: { type: 'reference', ref: 'Customer' },
        hiddenCustomer: { type: 'reference', ref: 'Customer' },
      },
    });
    await host.create(name, { customer: other, hiddenCustomer: other });
    await run({ type: 'hideField', model: name, field: 'hiddenCustomer' });
  }
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});
const command = (): Extract<Command, { type: 'mergeRecords' }> => ({
  type: 'mergeRecords',
  model: 'Customer',
  keep,
  merge: [other],
  fields: { name: 'keep', email: other },
});

it('always gates merges; previews every reference, chooses values and undoes raw rows exactly', async () => {
  const before = raw();
  expect((await host.plan(command())).preview).toEqual({
    removed: 1,
    references: { Note: 2, Task: 2 },
  });
  await expect(host.execute(command(), { author: 't' })).rejects.toBeInstanceOf(
    ApprovalRequiredError,
  );
  await run(command());
  expect(await host.list('Customer')).toHaveLength(1);
  expect((await host.get('Customer', keep)).email).toBe('ada@example.test');
  for (const model of ['Note', 'Task'])
    expect((await host.list(model))[0].customer).toBe(keep);
  await host.close();
  host = await AppHost.open(dir, { store });
  await run({ type: 'undo' });
  expect(raw()).toEqual(before);
});

it('refuses invalid ids and selectors; rolls back partial reference changes', async () => {
  await expect(
    host.plan({ ...command(), merge: [keep] } as Command),
  ).rejects.toThrow(/distinct/);
  await expect(
    host.plan({ ...command(), fields: { name: 'foreign' } } as Command),
  ).rejects.toThrow(/selector/);
  await expect(
    host.plan({ ...command(), merge: ['missing'] } as Command),
  ).rejects.toThrow(/not found/);
  const before = raw();
  const version = host.version;
  const db = new DatabaseSync(join(dir, 'app.db'));
  db.exec(
    "CREATE TRIGGER reject_merge BEFORE UPDATE ON u_tasks BEGIN SELECT RAISE(ABORT, 'injected merge failure'); END",
  );
  db.close();
  await expect(run(command())).rejects.toThrow(/not applied/);
  expect(raw()).toEqual(before);
  expect(host.version).toBe(version);
  const db2 = new DatabaseSync(join(dir, 'app.db'));
  db2.exec('DROP TRIGGER reject_merge');
  db2.close();
});

it('publishes a draft merge against current live references and undoes them', async () => {
  const draft = await host.forkDraft(`${dir}-draft`, {
    store: new MemoryVersionStore(),
  });
  try {
    await draft.execute(command(), { author: 't' });
    const late = await host.create('Note', { customer: other });
    const before = raw();
    const p = await host.previewPublish(draft);
    await host.publishDraft(draft, {
      author: 't',
      approved: true,
      expect: p.digest,
    });
    expect((await host.get('Note', String(late.id))).customer).toBe(keep);
    await run({ type: 'undo' });
    expect(raw()).toEqual(before);
  } finally {
    await draft.discard();
  }
});

it.each([
  'constructor',
  '__proto__',
])('rejects inherited merge selector field %s with a typed refusal', async (field) => {
  const before = raw();
  const version = host.version;
  const cmd: Command = { ...command(), fields: { [field]: other } };
  const error = {
    name: 'EngineError',
    code: 'invalid',
    message: `merge field '${field}' is not writable`,
  };
  await expect(host.plan(cmd)).rejects.toMatchObject(error);
  await expect(run(cmd)).rejects.toMatchObject(error);
  expect(raw()).toEqual(before);
  expect(host.version).toBe(version);
});

it('keeps later note edits, refuses user deletions and changed repointed columns atomically', async () => {
  await run({
    type: 'addField',
    model: 'Note',
    field: 'body',
    definition: { type: 'text' },
  });
  const first = await host.create('Note', {
    customer: other,
    body: 'original',
  });
  const second = await host.create('Note', { customer: other, body: 'second' });
  await run(command());
  await host.update('Note', String(first.id), { body: 'edited later' });
  await run({ type: 'undo' });
  expect(await host.get('Note', String(first.id))).toMatchObject({
    body: 'edited later',
    customer: other,
  });
  await run(command());
  await host.update('Note', String(first.id), { customer: null });
  await expect(run({ type: 'undo' })).rejects.toThrow(/changed since/);
  expect(await host.list('Customer')).toHaveLength(1);
  await host.update('Note', String(first.id), { customer: keep });
  await host.remove('Note', String(second.id));
  await expect(run({ type: 'undo' })).rejects.toThrow(/deleted since/);
  expect(await host.list('Customer')).toHaveLength(1);
  expect((await host.list('Note')).some((r) => r.id === second.id)).toBe(false);
  expect(await host.get('Note', String(first.id))).toMatchObject({
    body: 'edited later',
    customer: keep,
  });
});
