// Node-only fixture producer: jsdom's browser conditions cannot boot app models.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppHost, type Command, MemoryVersionStore } from '../src/engine/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'approval-engine-'));
const host = await AppHost.open(dir, { store: new MemoryVersionStore() });
const cards: unknown[] = [];
const execute = (command: Command) =>
  host.execute(command, { author: 'owner', approved: true });
async function collect(name: string, command: Command) {
  const plan = await host.plan(command);
  const models = host.describe().models;
  const model = 'model' in command ? models[command.model] : undefined;
  cards.push({
    name,
    command,
    summary: plan.summary,
    preview: {
      ...plan.preview,
      ...(model ? { modelLabel: model.label, fields: model.fields } : {}),
      ...('field' in command && model
        ? { fieldLabel: model.fields[command.field]?.label }
        : {}),
    },
  });
}
try {
  await execute({
    type: 'defineModel',
    name: 'Customer',
    label: 'Customers',
    fields: {
      name: { type: 'text' },
      qty: { type: 'integer', label: 'Quantity' },
      amount: { type: 'integer', label: 'Invoice total' },
      category: { type: 'text', label: 'Category name' },
    },
  });
  const a = await host.create('Customer', {
    name: 'Acme',
    qty: 2,
    amount: 8,
    category: 'Food',
  });
  const b = await host.create('Customer', {
    name: 'Other',
    qty: 1,
    amount: 3,
    category: 'Food',
  });
  await collect('insert', {
    type: 'loadRecords',
    model: 'Customer',
    mode: 'insert',
    rows: [{ name: 'Third' }],
  });
  await collect('upsert', {
    type: 'loadRecords',
    model: 'Customer',
    mode: 'upsert',
    key: ['name'],
    rows: [{ name: 'Acme', amount: 9 }],
  });
  await collect('merge', {
    type: 'mergeRecords',
    model: 'Customer',
    keep: String(a.id),
    merge: [String(b.id)],
  });
  await collect('extract', {
    type: 'extractModel',
    model: 'Customer',
    field: 'category',
    into: 'Category',
  });
  const calculation: Command = {
    type: 'setCalculation',
    model: 'Customer',
    field: 'amount',
    calculated: { col: 'qty' },
  };
  await collect('plain', calculation);
  await execute(calculation);
  await collect('replace', { ...calculation, calculated: { value: 3 } });
  await collect('clear', { ...calculation, calculated: null });
  await collect('undo', { type: 'undo' });
  await execute({
    type: 'defineModel',
    name: 'Empty',
    fields: { qty: { type: 'integer' }, amount: { type: 'integer' } },
  });
  await collect('empty', { ...calculation, model: 'Empty' });
  writeFileSync(process.argv[2], JSON.stringify(cards));
} finally {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
}
