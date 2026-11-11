import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  expect(post.status).toBeGreaterThanOrEqual(400);
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
    { literal: 'wrong' },
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
