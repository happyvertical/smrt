import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AppHost, type Command, MemoryVersionStore } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'extract-4916-'));
const store = new MemoryVersionStore();
let host: AppHost;
const run = (cmd: Command) =>
  host.execute(cmd, { author: 't', approved: true });
const raw = (table: string) => {
  const db = new DatabaseSync(join(dir, 'app.db'));
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  } finally {
    db.close();
  }
};
beforeAll(async () => {
  host = await AppHost.open(dir, { store });
  await run({
    type: 'defineModel',
    name: 'Sale',
    fields: { category: { type: 'text' } },
  });
  for (const category of ['Food', 'Food', ' food ', '', null])
    await host.create('Sale', { category });
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

it('extracts exact distinct nonempty values; undo restores raw source and removes only created rows', async () => {
  const before = raw('u_sales');
  const cmd: Command = {
    type: 'extractModel',
    model: 'Sale',
    field: 'category',
    into: 'Category',
  };
  expect((await host.plan(cmd)).preview).toMatchObject({
    distinct: 2,
    folded: 0,
    create: 2,
    matched: 0,
    rows: 3,
  });
  await expect(host.execute(cmd, { author: 't' })).rejects.toMatchObject({
    code: 'approval_required',
  });
  await run(cmd);
  expect(host.def.models.Sale.fields.category).toMatchObject({
    type: 'reference',
    ref: 'Category',
  });
  expect((await host.list('Category')).map((r) => r.name).sort()).toEqual([
    ' food ',
    'Food',
  ]);
  const labels = new Map(
    (await host.list('Category')).map((r) => [r.id, r.name]),
  );
  expect(
    (await host.list('Sale'))
      .map((r) => labels.get(r.category) ?? r.category)
      .sort(),
  ).toEqual(['', ' food ', 'Food', 'Food', null].sort());
  await host.close();
  host = await AppHost.open(dir, { store });
  await run({ type: 'undo' });
  expect(raw('u_sales')).toEqual(before);
  expect(raw('u_categorys')).toEqual([]);
});

it('folds only when requested, matches existing targets and refuses undo with new references from two models', async () => {
  await run({
    type: 'defineModel',
    name: 'Group',
    fields: { name: { type: 'text' } },
  });
  const existing = await host.create('Group', { name: 'Unrelated' });
  for (const name of ['Note', 'Task'])
    await run({
      type: 'defineModel',
      name,
      fields: { groupId: { type: 'reference', ref: 'Group' } },
    });
  const before = raw('u_sales');
  const cmd: Command = {
    type: 'extractModel',
    model: 'Sale',
    field: 'category',
    into: 'Group',
    normalize: true,
  };
  expect((await host.plan(cmd)).preview).toMatchObject({
    distinct: 2,
    folded: 1,
    create: 1,
    matched: 0,
  });
  await run(cmd);
  const created = (await host.list('Group')).find((r) => r.id !== existing.id);
  const note = await host.create('Note', { groupId: created?.id });
  const task = await host.create('Task', { groupId: created?.id });
  await expect(run({ type: 'undo' })).rejects.toThrow(/still references/);
  await host.remove('Note', String(note.id));
  await expect(run({ type: 'undo' })).rejects.toThrow(/Task.groupId/);
  await host.remove('Task', String(task.id));
  await run({ type: 'undo' });
  expect(raw('u_sales')).toEqual(before);
  expect((await host.list('Group')).map((r) => r.id)).toEqual([existing.id]);
  await host.create('Group', { name: 'FOOD' });
  expect((await host.plan(cmd)).preview).toMatchObject({
    matched: 1,
    create: 0,
  });
});

it('replays extraction on live values and rolls back an injected partial migration failure', async () => {
  const before = raw('u_sales');
  const db = new DatabaseSync(join(dir, 'app.db'));
  db.exec(
    "CREATE TRIGGER reject_extract BEFORE UPDATE ON u_sales WHEN OLD.category = ' food ' BEGIN SELECT RAISE(ABORT, 'injected extract failure'); END",
  );
  db.close();
  const cmd: Command = {
    type: 'extractModel',
    model: 'Sale',
    field: 'category',
    into: 'Department',
  };
  await expect(run(cmd)).rejects.toThrow(/not applied/);
  expect(raw('u_sales')).toEqual(before);
  const db2 = new DatabaseSync(join(dir, 'app.db'));
  db2.exec('DROP TRIGGER reject_extract');
  db2.close();
  const draft = await host.forkDraft(`${dir}-draft`, {
    store: new MemoryVersionStore(),
  });
  try {
    await draft.execute(cmd, { author: 't' });
    await host.create('Sale', { category: 'Live' });
    const p = await host.previewPublish(draft);
    await host.publishDraft(draft, {
      author: 't',
      approved: true,
      expect: p.digest,
    });
    expect((await host.list('Department')).map((r) => r.name).sort()).toEqual([
      ' food ',
      'Food',
      'Live',
    ]);
    await run({ type: 'undo' });
    expect((await host.list('Sale')).map((r) => r.category)).toContain('Live');
  } finally {
    await draft.discard();
  }
});

it('matches existing targets that have other required fields without inventing values', async () => {
  await run({
    type: 'defineModel',
    name: 'Known',
    fields: {
      name: { type: 'text', required: true },
      note: { type: 'text', required: true },
    },
  });
  for (const name of ['Food', 'Live'])
    await host.create('Known', { name, note: 'Existing metadata' });
  const before = raw('u_sales');
  const targets = raw('u_knowns');
  const command: Command = {
    type: 'extractModel',
    model: 'Sale',
    field: 'category',
    into: 'Known',
    normalize: true,
  };
  expect((await host.plan(command)).preview).toMatchObject({
    create: 0,
    matched: 2,
  });
  await run(command);
  await run({ type: 'undo' });
  expect(raw('u_sales')).toEqual(before);
  expect(raw('u_knowns')).toEqual(targets);
});
