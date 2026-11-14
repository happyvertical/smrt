import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AppHost, type Command, MemoryVersionStore } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'calc-4916-'));
const store = new MemoryVersionStore();
let host: AppHost;
const run = (cmd: Command) =>
  host.execute(cmd, { author: 't', approved: true });
const expression = {
  op: 'mul',
  left: { col: 'qty' },
  right: { col: 'price' },
} as const;
beforeAll(async () => {
  host = await AppHost.open(dir, { store });
  await run({
    type: 'defineModel',
    name: 'Sale',
    fields: { qty: { type: 'integer' }, price: { type: 'money' } },
  });
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

it('adds database-owned values, rejects writes, rewrites renames and undoes exactly', async () => {
  const cmd: Command = {
    type: 'addField',
    model: 'Sale',
    field: 'total',
    definition: { type: 'money', calculated: expression },
  };
  expect((await host.plan(cmd)).summary).toBe(
    ((await run(cmd)) as { summary: string }).summary,
  );
  const row = await host.create('Sale', { qty: 3, price: 125 });
  expect(row.total).toBe(375);
  await expect(
    host.update('Sale', String(row.id), { total: 1 }),
  ).rejects.toThrow(/read-only/);
  expect(
    JSON.stringify(
      (await host.appTools()).find((t) => t.name === 'sale_create')
        ?.inputSchema,
    ),
  ).not.toContain('"total"');
  const post = await host.rest({
    method: 'POST',
    url: '/api/sales',
    body: JSON.stringify({ qty: 1, price: 1, total: 2 }),
  });
  expect(post.status).toBe(201);
  expect(JSON.parse(post.body).total).toBe(1);
  const mcp = await host.callAppTool('sale_create', {
    qty: 2,
    price: 3,
    total: 999,
  });
  expect(mcp.isError).toBe(false);
  await expect(
    host.create('Sale', { qty: 1, price: 2, total: 9 }),
  ).rejects.toMatchObject({
    code: 'invalid',
    message: expect.stringContaining('read-only'),
  });
  await expect(
    host.plan({
      type: 'loadRecords',
      model: 'Sale',
      mode: 'upsert',
      key: ['total'],
      rows: [{ qty: 1, price: 2 }],
    }),
  ).rejects.toThrow();
  for (const type of ['removeField', 'hideField', 'changeFieldType'] as const)
    await expect(
      host.plan({
        type,
        model: 'Sale',
        field: 'qty',
        to: { type: 'number' },
      } as Command),
    ).rejects.toThrow(/calculated field Sale.total/);
  await run({ type: 'renameField', model: 'Sale', from: 'qty', to: 'units' });
  expect(host.def.models.Sale.fields.total.calculated).toEqual({
    ...expression,
    left: { col: 'units' },
  });
  expect((await host.get('Sale', String(row.id))).total).toBe(375);
  await run({ type: 'undo' });
  expect(host.def.models.Sale.fields.total.calculated).toEqual(expression);
  await run({
    type: 'setCalculation',
    model: 'Sale',
    field: 'total',
    calculated: { col: 'qty' },
  });
  expect((await host.get('Sale', String(row.id))).total).toBe(3);
  await run({ type: 'undo' });
  expect((await host.get('Sale', String(row.id))).total).toBe(375);
  await host.close();
  host = await AppHost.open(dir, { store });
  expect((await host.get('Sale', String(row.id))).total).toBe(375);
});

it('validates SDK expressions before applying anything', async () => {
  for (const calculated of [
    { col: 'missing' },
    { col: 'total' },
    { value: 'wrong' },
  ])
    await expect(
      host.plan({
        type: 'addField',
        model: 'Sale',
        field: 'bad',
        definition: { type: 'integer', calculated },
      } as Command),
    ).rejects.toThrow();
  await run({
    type: 'addField',
    model: 'Sale',
    field: 'secret',
    definition: { type: 'integer' },
  });
  await run({ type: 'hideField', model: 'Sale', field: 'secret' });
  await expect(
    host.plan({
      type: 'addField',
      model: 'Sale',
      field: 'bad',
      definition: { type: 'integer', calculated: { col: 'secret' } },
    }),
  ).rejects.toThrow();
});

it('clears and restores an expression and replays changes from a draft on current live data', async () => {
  const draft = await host.forkDraft(
    join(dir, '..', `${dir.split('/').pop()}-draft`),
    { store: new MemoryVersionStore() },
  );
  try {
    await draft.execute(
      {
        type: 'setCalculation',
        model: 'Sale',
        field: 'total',
        calculated: null,
      },
      { author: 't' },
    );
    await draft.execute({ type: 'undo' }, { author: 't' });
    await draft.execute(
      {
        type: 'setCalculation',
        model: 'Sale',
        field: 'total',
        calculated: { col: 'price' },
      },
      { author: 't' },
    );
    const live = await host.create('Sale', { qty: 2, price: 10 });
    const p = await host.previewPublish(draft);
    await host.publishDraft(draft, {
      author: 't',
      approved: true,
      expect: p.digest,
    });
    expect((await host.get('Sale', String(live.id))).total).toBe(10);
    await run({ type: 'undo' });
    expect((await host.get('Sale', String(live.id))).total).toBe(20);
  } finally {
    await draft.discard();
  }
});

it('preserves writable orphan columns when adding calculations and replaces retained model expressions', async () => {
  await run({
    type: 'addField',
    model: 'Sale',
    field: 'bonus',
    definition: { type: 'integer' },
  });
  const row = (await host.list('Sale'))[0];
  await host.update('Sale', String(row.id), { bonus: 123 });
  await run({ type: 'undo' });
  const command: Command = {
    type: 'addField',
    model: 'Sale',
    field: 'bonus',
    definition: { type: 'integer', calculated: { col: 'qty' } },
  };
  expect((await host.plan(command)).risky).toBe(true);
  await run(command);
  await run({ type: 'undo' });
  const db = new DatabaseSync(join(dir, 'app.db'), { readOnly: true });
  try {
    expect(
      db.prepare('SELECT bonus FROM u_sales WHERE id = ?').get(String(row.id))
        ?.bonus,
    ).toBe(123);
  } finally {
    db.close();
  }
  const fields = {
    qty: { type: 'integer' as const },
    total: { type: 'integer' as const, calculated: { col: 'qty' } },
  };
  await run({ type: 'defineModel', name: 'Line', fields });
  const line = await host.create('Line', { qty: 3 });
  await run({ type: 'undo' });
  await run({
    type: 'defineModel',
    name: 'Line',
    fields: {
      ...fields,
      total: {
        type: 'integer',
        calculated: { op: 'mul', left: { col: 'qty' }, right: { value: 3 } },
      },
    },
  });
  expect((await host.get('Line', String(line.id))).total).toBe(9);
});

it('rejects generated writes proposed by sandbox methods', async () => {
  await run({
    type: 'addMethod',
    model: 'Sale',
    name: 'badWrite',
    method: {
      description: 'test read-only',
      code: "app.create('Sale', { qty: 1, price: 2, total: 7 });",
    },
  });
  await expect(host.runMethod('Sale', 'badWrite')).rejects.toThrow(/read-only/);
});

it('materializes a cleared calculation and refuses undo that would discard later writable edits', async () => {
  const row = (await host.list('Sale'))[0];
  await run({
    type: 'setCalculation',
    model: 'Sale',
    field: 'total',
    calculated: null,
  });
  expect((await host.get('Sale', String(row.id))).total).toBe(row.total);
  await host.update('Sale', String(row.id), { total: 999 });
  const plan = await host.plan({ type: 'undo' });
  expect(plan.risky).toBe(true);
  expect(Number(plan.preview?.replaced)).toBeGreaterThanOrEqual(1);
  await expect(
    host.execute({ type: 'undo' }, { author: 't' }),
  ).rejects.toMatchObject({ code: 'approval_required' });
  const version = host.version;
  await expect(run({ type: 'undo' })).rejects.toThrow(
    /writable values changed since clearing/,
  );
  expect(host.version).toBe(version);
  expect((await host.get('Sale', String(row.id))).total).toBe(999);
  await host.update('Sale', String(row.id), { total: row.total });
  await run({ type: 'undo' });
  expect((await host.get('Sale', String(row.id))).total).toBe(
    Number(row.qty) * Number(row.price),
  );
});

it('changes a calculated field type directly and undoes without a value archive', async () => {
  const before = structuredClone(host.def);
  const row = (await host.list('Sale'))[0];
  await run({
    type: 'changeFieldType',
    model: 'Sale',
    field: 'total',
    to: { type: 'number' },
  });
  expect(host.def.models.Sale.fields.total.type).toBe('number');
  expect((await host.get('Sale', String(row.id))).total).toBe(row.total);
  expect((await host.plan({ type: 'undo' })).risky).toBe(false);
  await host.execute({ type: 'undo' }, { author: 't' });
  expect(host.def).toEqual(before);
});

it('refuses date operands and protected reference/title keys during preflight', async () => {
  await run({
    type: 'defineModel',
    name: 'Calendar',
    fields: {
      name: { type: 'text' },
      when: { type: 'date' },
      value: { type: 'integer' },
      related: { type: 'reference', ref: 'Sale' },
    },
  });
  for (const calculated of [
    { op: 'day', value: { col: 'when' } },
    {
      op: 'daysBetween',
      earlier: { col: 'when' },
      later: { value: { kind: 'date', iso: '2024-01-01' } },
    },
    { op: 'addDays', value: { col: 'when' }, days: { value: 1 } },
  ]) {
    for (const cmd of [
      {
        type: 'addField',
        model: 'Calendar',
        field: 'derived',
        definition: { type: 'integer', calculated },
      },
      { type: 'setCalculation', model: 'Calendar', field: 'value', calculated },
    ])
      await expect(host.plan(cmd as Command)).rejects.toMatchObject({
        code: 'invalid',
        message: expect.stringContaining('sdk#1516'),
      });
  }
  for (const field of ['name', 'related'])
    await expect(
      host.plan({
        type: 'setCalculation',
        model: 'Calendar',
        field,
        calculated: { value: field === 'name' ? 'derived' : 1 },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
});

it('protects identity, ownership, system and inherited calculation targets', async () => {
  for (const field of ['id', 'tenantId', 'createdAt', '_type'])
    await expect(
      host.plan({
        type: 'defineModel',
        name: 'Protected',
        fields: { [field]: { type: 'integer', calculated: { value: 1 } } },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  await run({ type: 'enableRecipe', recipe: 'profiles' });
  await expect(
    host.plan({
      type: 'setCalculation',
      model: 'Profile',
      field: 'email',
      calculated: { value: 'derived' },
    }),
  ).rejects.toThrow(/built in/);
});

it('refuses calculated date outputs before addField and setCalculation apply', async () => {
  const calculated = {
    op: 'addDays',
    value: { value: { kind: 'date', iso: '2024-01-01' } },
    days: { value: 1 },
  } as const;
  for (const cmd of [
    {
      type: 'addField',
      model: 'Calendar',
      field: 'tomorrow',
      definition: { type: 'date', calculated },
    },
    { type: 'setCalculation', model: 'Calendar', field: 'when', calculated },
  ])
    await expect(host.plan(cmd as Command)).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining(
        'calculated date outputs are temporarily unavailable',
      ),
    });
});

it('clears and undoes floating calculations without changing any double bits', async () => {
  await run({
    type: 'defineModel',
    name: 'Precise',
    fields: {
      input: { type: 'number' },
      offset: { type: 'number' },
      output: {
        type: 'number',
        calculated: {
          op: 'add',
          left: { col: 'input' },
          right: { col: 'offset' },
        },
      },
    },
  });
  const ids = [];
  for (const [input, offset] of [
    [0.1, 0.2],
    [1.2345678901234567, 0],
  ])
    ids.push(String((await host.create('Precise', { input, offset })).id));
  const before = await Promise.all(ids.map((id) => host.get('Precise', id)));
  await run({
    type: 'setCalculation',
    model: 'Precise',
    field: 'output',
    calculated: null,
  });
  for (let i = 0; i < ids.length; i++)
    expect((await host.get('Precise', ids[i])).output).toBe(before[i].output);
  await run({ type: 'undo' });
  for (let i = 0; i < ids.length; i++)
    expect((await host.get('Precise', ids[i])).output).toBe(before[i].output);
});
