// The engine's migration, data and report flows on PostgreSQL (PGlite) with
// assertions through the host API and the PostgreSQL catalog (#5186). The
// SQLite suites that read `app.db` with `node:sqlite` cannot run there; this
// is their PostgreSQL counterpart for the engine paths that differ: column
// conversion, rename, drop with archive, table archive, undo, clean up,
// calculated columns, record loads, merge, extract, methods and reports.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harnessDatabase } from './db/harness.ts';
import {
  AppHost,
  ApprovalRequiredError,
  type Command,
  EngineError,
  MemoryVersionStore,
} from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'engine-pg-flows-'));
const store = new MemoryVersionStore();
let host: AppHost;
let pg: Awaited<ReturnType<typeof harnessDatabase>>;
const client = () => {
  if (pg.config.kind !== 'pglite') throw new Error('not pglite');
  return pg.config.client;
};
const raw = async (sql: string, params: unknown[] = []) =>
  client().transaction(async (tx) => {
    await tx.query(`SELECT set_config('search_path', 'app', true)`);
    return (await tx.query(sql, params)).rows as Array<Record<string, any>>;
  });
const cols = async (table: string) =>
  (
    await raw(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = $1`,
      [table],
    )
  ).map((r) => r.column_name as string);
const colType = async (table: string, column: string) =>
  (
    await raw(
      `SELECT data_type FROM information_schema.columns WHERE table_schema = 'app' AND table_name = $1 AND column_name = $2`,
      [table, column],
    )
  )[0]?.data_type;
const run = (cmd: Command, approved = true) =>
  host.execute(cmd, { author: 'test', approved });
const open = () =>
  AppHost.open(dir, { store, database: pg.config, workerLimits: undefined });

beforeAll(async () => {
  pg = await harnessDatabase(dir);
  host = await open();
});
afterAll(async () => {
  await host.close();
  await pg.release?.();
  rmSync(dir, { recursive: true, force: true });
});

describe('migrations on PostgreSQL (sequential, one app)', () => {
  const ids: string[] = [];
  let late = '';

  it('defines a model and takes records; the engine made a real schema table', async () => {
    await run({
      type: 'defineModel',
      name: 'Chore',
      fields: {
        title: { type: 'text', required: true },
        points: { type: 'text' },
        done: { type: 'boolean' },
        notes: { type: 'text' },
      },
    });
    for (const [title, points, notes] of [
      ['Bins', '3', 'blue bin'],
      ['Dishes', '5', null],
      ['Garage', 'lots', 'big job'],
      ['Lawn', null, null],
    ] as const)
      ids.push(
        (await host.create('Chore', { title, points, notes })).id as string,
      );
    expect(await colType('u_chores', 'done')).toBe('boolean');
    expect((await raw(`SELECT count(*)::int AS n FROM u_chores`))[0].n).toBe(4);
  });

  it('changeFieldType text -> integer: preview, convert, empty the bad value', async () => {
    const cmd: Command = {
      type: 'changeFieldType',
      model: 'Chore',
      field: 'points',
      to: { type: 'integer' },
    };
    const plan = await host.plan(cmd);
    expect(plan.risky).toBe(true);
    expect((plan.preview as { failingCount: number }).failingCount).toBe(1);
    await run(cmd);
    expect(await colType('u_chores', 'points')).toBe('bigint');
    expect(
      (await raw(`SELECT points FROM u_chores ORDER BY title`)).map((r) =>
        r.points == null ? null : Number(r.points),
      ),
    ).toEqual([3, 5, null, null]);
    late = (await host.create('Chore', { title: 'Windows', points: 7 }))
      .id as string;
  });

  it('renameField keeps data and renames the generated tool parameter', async () => {
    await run({
      type: 'renameField',
      model: 'Chore',
      from: 'title',
      to: 'name',
    });
    expect((await host.get('Chore', ids[0])).name).toBe('Bins');
    expect(await cols('u_chores')).toContain('name');
  });

  it('removeField archives the values and drops the column', async () => {
    const cmd: Command = {
      type: 'removeField',
      model: 'Chore',
      field: 'notes',
    };
    expect(
      ((await host.plan(cmd)).preview as { valuesArchived: number })
        .valuesArchived,
    ).toBe(2);
    await run(cmd);
    expect(await cols('u_chores')).not.toContain('notes');
    expect(
      (
        await raw(`SELECT count(*)::int AS n FROM _archive WHERE col = 'notes'`)
      )[0].n,
    ).toBe(2);
  });

  it('a subclass field on the shipped Profile table renames and keeps its value', async () => {
    await run({ type: 'enableRecipe', recipe: 'profiles' });
    await run({
      type: 'addField',
      model: 'Profile',
      field: 'nickname',
      definition: { type: 'text' },
    });
    await host.create('Profile', { name: 'Sam', nickname: 'Sammy' });
    await run({
      type: 'renameField',
      model: 'Profile',
      from: 'nickname',
      to: 'callMe',
    });
    expect(await cols('profiles')).toContain('call_me');
    expect((await host.list('Profile'))[0].callMe).toBe('Sammy');
  });

  it('removeModel moves the table aside', async () => {
    await run({
      type: 'defineModel',
      name: 'Errand',
      fields: { what: { type: 'text' } },
    });
    await host.create('Errand', { what: 'post office' });
    await run({ type: 'removeModel', model: 'Errand' });
    const tables = (
      await raw(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'app'`,
      )
    ).map((r) => r.table_name as string);
    expect(
      tables.filter((t) => t.startsWith('_archived_u_errands_')),
    ).toHaveLength(1);
    expect(tables).not.toContain('u_errands');
  });

  it('a failing migration is refused, rolled back, and the app keeps running', async () => {
    await run({
      type: 'addField',
      model: 'Chore',
      field: 'extra',
      definition: { type: 'text' },
    });
    await run({ type: 'undo' }, false); // leaves an orphan 'extra' column behind
    const before = host.version;
    await expect(
      run({ type: 'renameField', model: 'Chore', from: 'name', to: 'extra' }),
    ).rejects.toBeInstanceOf(EngineError);
    expect(host.version).toBe(before);
    expect(await host.list('Chore')).toHaveLength(5);
    expect(await cols('u_chores')).toContain('name');
    expect(host.appAlive).toBe(true);
  });

  it('restart: state is intact', async () => {
    await host.close();
    host = await open();
    expect((await host.get('Chore', ids[0])).name).toBe('Bins');
  });

  it('undo walks back through every kind of step', async () => {
    const undo = () => host.execute({ type: 'undo' }, { author: 'test' });
    await undo(); // remove model Errand
    expect((await host.list('Errand'))[0].what).toBe('post office');
    await undo(); // define Errand
    await undo(); // rename nickname -> callMe
    expect((await host.list('Profile'))[0].nickname).toBe('Sammy');
    await undo(); // add nickname
    await undo(); // enable profiles
    await undo(); // remove notes
    expect((await host.get('Chore', ids[0])).notes).toBe('blue bin');
    expect(
      (
        await raw(`SELECT count(*)::int AS n FROM _archive WHERE col = 'notes'`)
      )[0].n,
    ).toBe(0);
    await undo(); // rename title -> name
    expect(await cols('u_chores')).toContain('title');
    await expect(undo()).rejects.toBeInstanceOf(ApprovalRequiredError);
    await run({ type: 'undo' }); // change type (approved)
    expect((await host.get('Chore', ids[2])).points).toBe('lots');
    expect(await colType('u_chores', 'points')).toBe('text');
    expect((await host.get('Chore', late)).points).toBe('7');
  });

  it('cleanUp makes old changes permanent; undo past one is refused', async () => {
    await run({ type: 'removeField', model: 'Chore', field: 'notes' });
    await run({
      type: 'addField',
      model: 'Chore',
      field: 'room',
      definition: { type: 'text' },
    });
    const cu = (await run({ type: 'cleanUp', keep: 1 })) as {
      purgedVersions: number[];
    };
    expect(cu.purgedVersions.length).toBeGreaterThanOrEqual(1);
    expect(
      (
        await raw(`SELECT count(*)::int AS n FROM _archive WHERE col = 'notes'`)
      )[0].n,
    ).toBe(0);
    await host.execute({ type: 'undo' }, { author: 'test' });
    await expect(
      host.execute({ type: 'undo' }, { author: 'test' }),
    ).rejects.toThrow(/cleaned up/);
  });
});

describe('data flows on PostgreSQL', () => {
  it('calculated columns, record loads with lookups, and exact undo', async () => {
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
        price: { type: 'money' },
        day: { type: 'date' },
        customer: { type: 'reference', ref: 'Customer' },
        total: {
          type: 'money',
          calculated: {
            op: 'mul',
            left: { col: 'qty' },
            right: { col: 'price' },
          },
        },
      },
    });
    const row = await host.create('Sale', { code: 'a', qty: 3, price: 125 });
    expect(row.total).toBe(375);
    await expect(
      host.update('Sale', String(row.id), { total: 1 }),
    ).rejects.toThrow(/read-only/);
    const cmd: Command = {
      type: 'loadRecords',
      model: 'Sale',
      mode: 'insert',
      rows: Array.from({ length: 50 }, (_, i) => ({
        code: `s${i}`,
        qty: '2',
        price: 10,
        day: '2026-01-05',
        customer: 'Ada',
      })),
      references: { customer: { model: 'Customer', by: 'name' } },
    };
    expect((await host.plan(cmd)).preview).toMatchObject({
      insert: 50,
      rejected: 0,
    });
    await run(cmd);
    expect(await host.list('Sale')).toHaveLength(51);
    await run({ type: 'undo' });
    expect(await host.list('Sale')).toHaveLength(1);
  });

  it('merges records and undoes; extracts a model and undoes', async () => {
    const keep = String((await host.create('Customer', { name: 'Bob' })).id);
    const other = String((await host.create('Customer', { name: 'B' })).id);
    await host.create('Sale', { code: 'm', qty: 1, price: 1, customer: other });
    const merge: Command = {
      type: 'mergeRecords',
      model: 'Customer',
      keep,
      merge: [other],
      fields: { name: 'keep' },
    };
    expect((await host.plan(merge)).preview).toMatchObject({
      removed: 1,
      references: { Sale: 1 },
    });
    await run(merge);
    expect(
      (await host.list('Sale')).find((s) => s.code === 'm')?.customer,
    ).toBe(keep);
    await run({ type: 'undo' });
    expect(
      (await host.list('Sale')).find((s) => s.code === 'm')?.customer,
    ).toBe(other);

    await run({
      type: 'defineModel',
      name: 'Visit',
      fields: { place: { type: 'text' } },
    });
    for (const place of ['Park', 'Park', 'Zoo'])
      await host.create('Visit', { place });
    const extract: Command = {
      type: 'extractModel',
      model: 'Visit',
      field: 'place',
      into: 'Place',
    };
    expect((await host.plan(extract)).preview).toMatchObject({
      distinct: 2,
      create: 2,
    });
    await run(extract);
    expect((await host.list('Place')).map((r) => r.name).sort()).toEqual([
      'Park',
      'Zoo',
    ]);
    await run({ type: 'undo' });
    expect((await host.list('Visit')).map((r) => r.place).sort()).toEqual([
      'Park',
      'Park',
      'Zoo',
    ]);
  });

  it('methods run atomically (no snapshot on PostgreSQL yet) and reports aggregate', async () => {
    await run({
      type: 'addMethod',
      model: 'Sale',
      name: 'bump',
      method: {
        description: 'bump qty',
        code: `app.update('Sale', record.id, { qty: record.qty + 1 }); return 'ok';`,
      },
    });
    const sale = (await host.list('Sale')).find((s) => s.code === 'a');
    const out = await host.runMethod('Sale', 'bump', String(sale?.id));
    expect(out.result).toBe('ok');
    expect(out.snapshot).toBeNull();
    expect((await host.get('Sale', String(sale?.id))).qty).toBe(4);

    await run({
      type: 'defineReport',
      name: 'byCode',
      definition: {
        spec: {
          title: 'By code',
          source: 'Sale',
          dimensions: [{ field: 'code', as: 'code' }],
          measures: [{ fn: 'sum', field: 'qty', as: 'qty' }],
        } as never,
      },
    });
    const report = await host.runReport('byCode');
    expect(report.rows.find((r) => r.code === 'a')?.qty).toBe(4);
  });

  it('an upsert load over date, boolean, json, integer and number fields undoes exactly; an outside edit refuses the undo', async () => {
    await run({
      type: 'defineModel',
      name: 'Item',
      fields: {
        code: { type: 'text', required: true },
        when: { type: 'date' },
        done: { type: 'boolean' },
        meta: { type: 'json' },
        count: { type: 'integer' },
        price: { type: 'number' },
      },
    });
    for (const [code, count] of [
      ['a', 5],
      ['b', 6],
    ] as const)
      await host.create('Item', {
        code,
        when: '2026-01-05',
        done: true,
        meta: { k: [1, 2] },
        count,
        price: 1.5,
      });
    const snapshot = async () =>
      (await host.list('Item')).sort((x, y) =>
        String(x.code).localeCompare(String(y.code)),
      );
    const before = await snapshot();
    const cmd: Command = {
      type: 'loadRecords',
      model: 'Item',
      mode: 'upsert',
      key: ['code'],
      rows: [
        {
          code: 'a',
          when: '2027-02-03',
          done: false,
          meta: { k: [3] },
          count: 9,
          price: 2.25,
        },
        { code: 'c', when: '2027-03-04', done: true, count: 1, price: 0.5 },
      ],
    };
    expect((await host.plan(cmd)).preview).toMatchObject({
      insert: 1,
      update: 1,
    });
    await run(cmd);
    const after = await snapshot();
    expect(after.map((r) => r.code)).toEqual(['a', 'b', 'c']);
    expect(after[0]).toMatchObject({ done: false, count: 9, price: 2.25 });
    expect(after[1]).toEqual(before[1]);
    await run({ type: 'undo' });
    expect(await snapshot()).toEqual(before);

    // The same load again; an edit outside it must refuse the undo.
    await run(cmd);
    const row = (await snapshot())[0];
    await host.update('Item', String(row.id), { count: 77 });
    await expect(run({ type: 'undo' })).rejects.toThrow(
      /changed since the command/,
    );
    expect((await host.get('Item', String(row.id))).count).toBe(77);
  });

  it.each([
    ['integer', { type: 'integer' }, 5, 9],
    ['money', { type: 'money' }, 1250, 99],
    ['boolean', { type: 'boolean' }, true, false],
  ] as const)('an upsert keyed on a %s field updates the existing row, and a reference lookup by it resolves', async (kind, def, first, second) => {
    const model = `K${kind}`;
    await run({
      type: 'defineModel',
      name: model,
      fields: { k: def as never, note: { type: 'text' } },
    });
    await host.create(model, { k: first, note: 'old' });
    const cmd: Command = {
      type: 'loadRecords',
      model,
      mode: 'upsert',
      key: ['k'],
      rows: [
        { k: first, note: 'new' },
        { k: second, note: 'added' },
      ],
    };
    expect((await host.plan(cmd)).preview).toMatchObject({
      insert: 1,
      update: 1,
    });
    await run(cmd);
    const rows = await host.list(model);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.k === first)?.note).toBe('new');

    const holder = `H${kind}`;
    await run({
      type: 'defineModel',
      name: holder,
      fields: {
        label: { type: 'text' },
        target: { type: 'reference', ref: model },
      },
    });
    const load: Command = {
      type: 'loadRecords',
      model: holder,
      mode: 'insert',
      rows: [{ label: 'x', target: first }],
      references: { target: { model, by: 'k' } },
    };
    expect((await host.plan(load)).preview).toMatchObject({
      insert: 1,
      rejected: 0,
    });
  });

  it('a very large integer reads back exactly', async () => {
    await run({
      type: 'defineModel',
      name: 'Big',
      fields: { n: { type: 'integer' } },
    });
    const rec = await host.create('Big', { n: 42 });
    await raw(`UPDATE u_bigs SET n = 9007199254740993 WHERE id = $1`, [rec.id]);
    expect((await raw(`SELECT n::text AS n FROM u_bigs`))[0].n).toBe(
      '9007199254740993',
    );
  });
});
