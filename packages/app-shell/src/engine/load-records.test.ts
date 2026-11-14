import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  AppHost,
  ApprovalRequiredError,
  type Command,
  EngineError,
  MemoryVersionStore,
} from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'load-4916-'));
const store = new MemoryVersionStore();
let host: AppHost;
const run = (cmd: Command) =>
  host.execute(cmd, { author: 't', approved: true });
const raw = () => {
  const db = new DatabaseSync(join(dir, 'app.db'));
  try {
    return db.prepare('SELECT * FROM u_sales ORDER BY id').all();
  } finally {
    db.close();
  }
};
beforeAll(async () => {
  host = await AppHost.open(dir, { store });
  await run({
    type: 'defineModel',
    name: 'Customer',
    fields: { name: { type: 'text' } },
  });
  await host.create('Customer', { name: 'Ada' });
  await run({
    type: 'defineModel',
    name: 'Sale',
    fields: {
      code: { type: 'text', required: true },
      qty: { type: 'integer' },
      customer: { type: 'reference', ref: 'Customer' },
      total: {
        type: 'integer',
        calculated: { op: 'mul', left: { col: 'qty' }, right: { value: 10 } },
      },
    },
  });
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

it('loads 10,000 coerced rows with batched lookups; undo removes only its inserted rows', async () => {
  const cmd: Command = {
    type: 'loadRecords',
    model: 'Sale',
    mode: 'insert',
    rows: Array.from({ length: 10000 }, (_, i) => ({
      code: `s${i}`,
      qty: '2',
      customer: 'Ada',
    })),
    references: { customer: { model: 'Customer', by: 'name' } },
  };
  expect((await host.plan(cmd)).preview).toMatchObject({
    insert: 10000,
    update: 0,
    rejected: 0,
  });
  const result = (await run(cmd)) as { snapshot: string | null };
  expect(result.snapshot).toBeTruthy();
  expect(raw()).toHaveLength(10000);
  expect((await host.list('Sale', 1))[0].total).toBe(20);
  await host.create('Sale', { code: 'later', qty: 9 });
  await run({ type: 'undo' });
  expect((await host.list('Sale')).map((r) => r.code)).toEqual(['later']);
}, 120000);

it('previews bounded row problems and refuses the whole load', async () => {
  const before = raw();
  const cmd: Command = {
    type: 'loadRecords',
    model: 'Sale',
    mode: 'insert',
    rows: [
      { code: 'good', qty: 1 },
      { code: 'bad', qty: 'secret row content', customer: 'Nobody' },
      { code: 'calculated', total: 3 },
    ],
    references: { customer: { model: 'Customer', by: 'name' } },
  };
  const plan = await host.plan(cmd);
  expect(plan.preview).toMatchObject({ insert: 1, rejected: 2 });
  expect(JSON.stringify(plan.preview)).not.toContain('secret row content');
  await expect(run(cmd)).rejects.toThrow(/rejected 2/);
  expect(raw()).toEqual(before);
  await expect(
    host.plan({ ...cmd, rows: Array.from({ length: 10001 }, () => ({})) }),
  ).rejects.toThrow(/10000/);
  await expect(
    host.plan({ ...cmd, rows: [{ code: 'x'.repeat(8 * 1024 * 1024) }] }),
  ).rejects.toThrow(/bytes/);
  await host.create('Customer', { name: 'Ada' });
  expect(
    (
      await host.plan({
        ...cmd,
        rows: [{ code: 'ambiguous', customer: 'Ada' }],
      })
    ).preview,
  ).toMatchObject({
    rejected: 1,
    problems: [
      { row: 0, field: 'customer', reason: 'ambiguous reference lookup' },
    ],
  });
});

it('upserts by key, counts unchanged, requires approval, and restores exact originals', async () => {
  if (!(await host.list('Sale')).some((r) => r.code === 'later'))
    await host.create('Sale', { code: 'later', qty: 9 });
  const before = raw();
  const cmd: Command = {
    type: 'loadRecords',
    model: 'Sale',
    mode: 'upsert',
    key: ['code'],
    rows: [
      { code: 'later', qty: 10 },
      { code: 'new', qty: 4 },
    ],
  };
  expect((await host.plan(cmd)).preview).toMatchObject({
    insert: 1,
    update: 1,
    unchanged: 0,
    rejected: 0,
  });
  await expect(host.execute(cmd, { author: 't' })).rejects.toBeInstanceOf(
    ApprovalRequiredError,
  );
  await run(cmd);
  expect((await host.plan(cmd)).preview).toMatchObject({
    unchanged: 2,
    insert: 0,
    update: 0,
  });
  await run({ type: 'undo' });
  expect(raw()).toEqual(before);
});

it('rolls back a mid-load database failure, restarts intact, and replays from a draft', async () => {
  const before = raw();
  const version = host.version;
  const db = new DatabaseSync(join(dir, 'app.db'));
  db.exec(
    "CREATE TRIGGER reject_load BEFORE INSERT ON u_sales WHEN NEW.code = 'fail' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  );
  db.close();
  await expect(
    run({
      type: 'loadRecords',
      model: 'Sale',
      mode: 'insert',
      rows: Array.from({ length: 101 }, (_, i) => ({
        code: i === 100 ? 'fail' : `batch${i}`,
      })),
    }),
  ).rejects.toThrow(/not applied/);
  expect(raw()).toEqual(before);
  expect(host.version).toBe(version);
  const db2 = new DatabaseSync(join(dir, 'app.db'));
  db2.exec('DROP TRIGGER reject_load');
  db2.close();
  await host.close();
  host = await AppHost.open(dir, { store });
  expect(raw()).toEqual(before);
  const draft = await host.forkDraft(`${dir}-draft`, {
    store: new MemoryVersionStore(),
  });
  try {
    await draft.execute(
      {
        type: 'loadRecords',
        model: 'Sale',
        mode: 'insert',
        rows: [{ code: 'replayed', qty: 5 }],
      },
      { author: 't' },
    );
    const id = (await draft.list('Sale')).find(
      (r) => r.code === 'replayed',
    )?.id;
    await draft.create('Sale', { code: 'draft-only' });
    await host.create('Sale', { code: 'live-only' });
    const p = await host.previewPublish(draft);
    await host.publishDraft(draft, {
      author: 't',
      approved: true,
      expect: p.digest,
    });
    expect((await host.get('Sale', String(id))).total).toBe(50);
    expect((await host.list('Sale')).map((r) => r.code).sort()).toEqual([
      'later',
      'live-only',
      'replayed',
    ]);
    await run({ type: 'undo' });
    expect((await host.list('Sale')).map((r) => r.code).sort()).toEqual([
      'later',
      'live-only',
    ]);
  } finally {
    await draft.discard();
  }
});

it('pins queued command data and restores rows with hidden generated storage', async () => {
  const command: Command = {
    type: 'loadRecords',
    model: 'Sale',
    mode: 'insert',
    rows: [{ code: 'pinned', qty: 3 }],
  };
  const pending = run(command);
  command.rows[0].qty = 999;
  await pending;
  expect((await host.list('Sale')).find((r) => r.code === 'pinned')?.qty).toBe(
    3,
  );
  await run({ type: 'hideField', model: 'Sale', field: 'total' });
  const before = raw();
  await run({
    type: 'loadRecords',
    model: 'Sale',
    mode: 'upsert',
    key: ['code'],
    rows: [{ code: 'pinned', qty: 4 }],
  });
  await run({ type: 'undo' });
  expect(raw()).toEqual(before);
  await run({ type: 'undo' });
});

it('bounds total command bytes before sending oversized metadata to a worker', async () => {
  await expect(
    host.plan({
      type: 'loadRecords',
      model: 'Sale',
      rows: [],
      mode: 'insert',
      references: {
        customer: { model: 'Customer', by: 'x'.repeat(8 * 1024 * 1024) },
      },
    }),
  ).rejects.toThrow(/bytes/);
});

it.each([
  'create',
  'update',
] as const)('refuses load undo atomically after a later reference %s, then succeeds once removed', async (operation) => {
  const customers = await host.list('Customer');
  const sale =
    operation === 'update'
      ? await host.create('Sale', { code: 'updated-reference' })
      : undefined;
  await run({
    type: 'loadRecords',
    model: 'Customer',
    mode: 'insert',
    rows: [{ name: 'Referenced' }, { name: 'Unreferenced' }],
  });
  const loaded = await host.list('Customer');
  const customer = loaded.find((r) => r.name === 'Referenced');
  const referring = sale
    ? await host.update('Sale', String(sale.id), { customer: customer?.id })
    : await host.create('Sale', {
        code: 'created-reference',
        customer: customer?.id,
      });
  const sales = raw();
  const version = host.version;
  await expect(
    host.execute({ type: 'undo' }, { author: 't' }),
  ).rejects.toBeInstanceOf(ApprovalRequiredError);
  const failure = await run({ type: 'undo' }).catch((error) => error);
  expect(failure).toBeInstanceOf(EngineError);
  expect(failure).toMatchObject({ code: 'migration_failed' });
  expect(failure.message).toMatch(
    /Sale.customer still references a created Customer record/,
  );
  expect(host.version).toBe(version);
  expect(await host.list('Customer')).toEqual(loaded);
  expect(raw()).toEqual(sales);
  await host.remove('Sale', String(referring.id));
  await run({ type: 'undo' });
  expect(await host.list('Customer')).toEqual(customers);
});
