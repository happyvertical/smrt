import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  AppHost,
  ApprovalRequiredError,
  type Command,
  EngineError,
  MemoryVersionStore,
} from './index.ts';

let dir: string;
let store: MemoryVersionStore;
let host: AppHost;
const run = (cmd: Command) =>
  host.execute(cmd, { author: 't', approved: true });
const raw = (dataDir = dir) => {
  const db = new DatabaseSync(join(dataDir, 'app.db'));
  try {
    return db.prepare('SELECT * FROM u_sales ORDER BY id').all();
  } finally {
    db.close();
  }
};
beforeEach(async () => {
  // Each attempt owns its data and history. A failed assertion must not leave
  // committed loads behind for another test or the CI runner's next attempt.
  dir = mkdtempSync(join(tmpdir(), 'load-4916-'));
  store = new MemoryVersionStore();
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
afterEach(async () => {
  vi.restoreAllMocks();
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
  await host.create('Sale', { code: 'later', qty: 9 });
  const before = raw();
  const version = host.version;
  const history = await store.list();
  const journal = new DatabaseSync(join(dir, 'app.db'));
  const archiveBefore = journal
    .prepare('SELECT * FROM _archive ORDER BY id')
    .all();
  journal.close();
  // Inject only after the disposable planning rehearsal: the failure must hit
  // row 101 of the real migration, after the first savepoint batch succeeded.
  const caller = host as unknown as {
    callApp: (op: string, ...args: unknown[]) => Promise<unknown>;
  };
  const original = caller.callApp.bind(host);
  const spy = vi
    .spyOn(caller, 'callApp')
    .mockImplementation(async (op, ...args) => {
      const result = await original(op, ...args);
      if (op === 'previewLoad') {
        const db = new DatabaseSync(join(dir, 'app.db'));
        try {
          db.exec(
            "CREATE TRIGGER reject_load BEFORE INSERT ON u_sales WHEN NEW.code = 'fail' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
          );
        } finally {
          db.close();
        }
      }
      return result;
    });
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
  spy.mockRestore();
  expect(raw()).toEqual(before);
  expect(host.version).toBe(version);
  expect(await store.list()).toEqual(history);
  expect(await store.current()).toBe(version);
  const db2 = new DatabaseSync(join(dir, 'app.db'));
  expect(db2.prepare('SELECT * FROM _archive ORDER BY id').all()).toEqual(
    archiveBefore,
  );
  db2.exec('DROP TRIGGER reject_load');
  db2.close();
  await host.close();
  host = await AppHost.open(dir, { store });
  expect(raw()).toEqual(before);
  const draft = await host.forkDraft(`${dir}-draft`, {
    store: new MemoryVersionStore(),
  });
  try {
    expect(raw(draft.dataDir)).toEqual(before);
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
    const liveBeforePublish = raw();
    const p = await host.previewPublish(draft);
    expect(raw()).toEqual(liveBeforePublish);
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
    expect(
      raw()
        .map((r) => r.code)
        .sort(),
    ).toEqual(['later', 'live-only', 'replayed']);
    await run({ type: 'undo' });
    expect((await host.list('Sale')).map((r) => r.code).sort()).toEqual([
      'later',
      'live-only',
    ]);
    expect(raw()).toEqual(liveBeforePublish);
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
    /Sale “(?:created|updated)-reference”: still refers to a record this undo would remove/,
  );
  expect(host.version).toBe(version);
  expect(await host.list('Customer')).toEqual(loaded);
  expect(raw()).toEqual(sales);
  await host.remove('Sale', String(referring.id));
  await run({ type: 'undo' });
  expect(await host.list('Customer')).toEqual(customers);
});

it.each([
  'constructor',
  '__proto__',
])('rejects inherited load row field %s with the normal unknown-field problem', async (field) => {
  const before = raw();
  const version = host.version;
  const cmd: Command = {
    type: 'loadRecords',
    model: 'Sale',
    mode: 'insert',
    rows: [{ code: 'unknown-field', [field]: null }],
  };
  expect((await host.plan(cmd)).preview).toMatchObject({
    insert: 0,
    rejected: 1,
    problems: [{ row: 0, field, reason: 'unknown or hidden field' }],
  });
  await expect(run(cmd)).rejects.toMatchObject({
    name: 'EngineError',
    code: 'invalid',
    message: 'loadRecords rejected 1 rows; no rows loaded',
  });
  expect(raw()).toEqual(before);
  expect(host.version).toBe(version);
});

it.each([
  'constructor',
  '__proto__',
])('rejects inherited load key and reference lookup field %s before preparation', async (field) => {
  const before = raw();
  const version = host.version;
  const commands: Command[] = [
    {
      type: 'loadRecords',
      model: 'Sale',
      mode: 'upsert',
      key: [field],
      rows: [],
    },
    {
      type: 'loadRecords',
      model: 'Sale',
      mode: 'insert',
      references: { customer: { model: 'Customer', by: field } },
      rows: [],
    },
  ];
  for (const [index, cmd] of commands.entries()) {
    const error = {
      name: 'EngineError',
      code: 'invalid',
      message: `invalid ${index === 0 ? 'key' : 'lookup'} field '${field}'`,
    };
    await expect(host.plan(cmd)).rejects.toMatchObject(error);
    await expect(run(cmd)).rejects.toMatchObject(error);
  }
  expect(raw()).toEqual(before);
  expect(host.version).toBe(version);
});

it('upsert undo keeps untouched fields and refuses later edits, deletions and edits of inserted rows', async () => {
  const customer = (await host.list('Customer'))[0];
  const sale = await host.create('Sale', { code: 'undo-safe', qty: 1 });
  const cmd: Command = {
    type: 'loadRecords',
    model: 'Sale',
    mode: 'upsert',
    key: ['code'],
    rows: [{ code: 'undo-safe', qty: 2 }],
  };
  await run(cmd);
  await host.update('Sale', String(sale.id), { customer: customer.id });
  await run({ type: 'undo' });
  expect(await host.get('Sale', String(sale.id))).toMatchObject({
    qty: 1,
    customer: customer.id,
  });
  await run(cmd);
  await host.update('Sale', String(sale.id), { qty: 3 });
  await expect(run({ type: 'undo' })).rejects.toThrow(/changed since/);
  await host.update('Sale', String(sale.id), { qty: 2 });
  await host.remove('Sale', String(sale.id));
  await expect(run({ type: 'undo' })).rejects.toThrow(/deleted since/);
  await run({
    type: 'loadRecords',
    model: 'Sale',
    mode: 'insert',
    rows: [{ code: 'insert-undo', qty: 1 }],
  });
  const inserted = (await host.list('Sale')).find(
    (r) => r.code === 'insert-undo',
  );
  await host.update('Sale', String(inserted?.id), { qty: 8 });
  await expect(run({ type: 'undo' })).rejects.toThrow(/changed since/);
  expect((await host.get('Sale', String(inserted?.id))).qty).toBe(8);
});

it('rechecks load update risk inside the transaction after an insert-only preview', async () => {
  const row = await host.create('Sale', { code: 'stale-load', qty: 7 });
  const cmd: Command = {
    type: 'loadRecords',
    model: 'Sale',
    mode: 'upsert',
    key: ['code'],
    rows: [{ code: 'stale-load', qty: 99 }],
  };
  const version = host.version;
  const caller = host as unknown as {
    callApp: (op: string, ...args: unknown[]) => Promise<unknown>;
  };
  const original = caller.callApp.bind(host);
  const spy = vi
    .spyOn(caller, 'callApp')
    .mockImplementation(async (op, ...args) => {
      if (op !== 'previewLoad') return original(op, ...args);
      const db = new DatabaseSync(join(dir, 'app.db'));
      try {
        db.prepare('UPDATE u_sales SET code = ? WHERE id = ?').run(
          'not-matched',
          String(row.id),
        );
      } finally {
        db.close();
      }
      const preview = await original(op, ...args);
      const restore = new DatabaseSync(join(dir, 'app.db'));
      try {
        restore
          .prepare('UPDATE u_sales SET code = ? WHERE id = ?')
          .run('stale-load', String(row.id));
      } finally {
        restore.close();
      }
      return preview;
    });
  try {
    await expect(
      host.execute(cmd, { author: 't', approved: true }),
    ).rejects.toThrow(/preview became stale/);
  } finally {
    spy.mockRestore();
  }
  expect(host.version).toBe(version);
  expect(await host.get('Sale', String(row.id))).toMatchObject({
    qty: 7,
    code: 'stale-load',
  });
  await expect(host.execute(cmd, { author: 't' })).rejects.toMatchObject({
    code: 'approval_required',
  });
  await run(cmd);
  expect((await host.get('Sale', String(row.id))).qty).toBe(99);
});
