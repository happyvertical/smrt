import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Node-only fixture producer: jsdom's browser conditions cannot boot app models.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppHost, type Command, MemoryVersionStore } from '../src/engine/index.ts';

import { commandSummary } from '../src/lib/ui/command-summary.ts';

const dir = mkdtempSync(join(tmpdir(), 'approval-engine-'));
const host = await AppHost.open(dir, { store: new MemoryVersionStore() });
const cards: unknown[] = [];
const execute = (command: Command) =>
  host.execute(command, { author: 'owner', approved: true });
function files() {
  return readdirSync(dir,{recursive:true}).map(String).sort().filter((file)=>statSync(join(dir,file)).isFile()).map((file)=>[file,createHash('sha256').update(readFileSync(join(dir,file))).digest('hex')]);
}
async function collect(name: string, command: Command) {
  const before = JSON.stringify(files());
  const version = host.version;
  const plan = await host.plan(command);
  if (JSON.stringify(files()) !== before || host.version !== version) throw new Error(`Preview ${name} wrote files or changed version`);
  const models = host.describe().models;
  const model = 'model' in command ? models[command.model] : undefined;
  const mergeRows = command.type === 'mergeRecords' ? await Promise.all(command.merge.slice(0, 10).map((id) => host.get(command.model, id))) : [];
  const keep = command.type === 'mergeRecords' ? await host.get(command.model, command.keep) : undefined;
  cards.push({
    name,
    command,
    summary: commandSummary(command,host.def,undefined,plan.preview),
    preview: {
      ...plan.preview,
      ...(command.type === 'mergeRecords' ? { keepLabel: keep?.name || 'the selected record', removedLabels: mergeRows.map((row) => row?.name || 'the selected record'), referenceLabels: { Order: 'Orders' } } : {}),
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
  await execute({ type: 'defineModel', name: 'Order', label: 'Orders', fields: { name: {type:'text'}, customer: {type:'reference', ref:'Customer'} } });
  await host.create('Order', {name:'First order',customer:b.id});
  await host.update('Customer', String(b.id), {name: '<b>Removed</b> ' + 'very long record label '.repeat(12)});
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
  await collect('undoCalculation', { type: 'undo' });
  await execute({type:'undo'});
  await execute({type:'loadRecords',model:'Customer',mode:'upsert',key:['name'],rows:[{name:'Acme',amount:22},{name:'Inserted'}]});
  await collect('undoLoad', {type:'undo'});
  const version = host.version;
  await host.update('Customer', String(a.id), {amount:23});
  await collect('undoRefused', {type:'undo'});
  let refused = false;
  try { await execute({type:'undo'}); } catch { refused = true; }
  if (!refused || host.version !== version || (await host.get('Customer',String(a.id)))?.amount !== 23) throw new Error('Refused undo changed data or version');

  await host.update('Customer',String(a.id),{amount:22});
  await execute({type:'undo'});
  await execute({type:'mergeRecords',model:'Customer',keep:String(a.id),merge:[String(b.id)]});
  await collect('undoMerge',{type:'undo'});
  await execute({type:'undo'});
  await execute({type:'extractModel',model:'Customer',field:'category',into:'Category'});
  await collect('undoExtract',{type:'undo'});
  await execute({type:'undo'});
  await execute({type:'changeFieldType',model:'Customer',field:'amount',to:{type:'text'}});
  await collect('undoType',{type:'undo'});
  await execute({type:'undo'});

  await execute({
    type: 'defineModel',
    name: 'Empty',
    fields: { qty: { type: 'integer' }, amount: { type: 'integer' } },
  });
  await collect('empty', { ...calculation, model: 'Empty' });
  const blank = await host.create('Customer',{name:''});
  const many = await Promise.all(Array.from({length:12},(_,i)=>host.create('Customer',{name:`Removed ${i+1}`})));
  await collect('mergeCapped',{type:'mergeRecords',model:'Customer',keep:String(blank.id),merge:many.map((row)=>String(row.id))});
  const routeOutput = join(dir,'route-approval.json');
  execFileSync(process.execPath,[fileURLToPath(new URL('../vitest.mjs',import.meta.resolve('vitest'))),'run','src/lib/server/approval-failure.test.ts'],{env:{...process.env,SMRT_ROUTE_APPROVAL_ARTIFACT:routeOutput},timeout:60000,stdio:'pipe'});
  cards.push({name:'undoFailed',view:JSON.parse(readFileSync(routeOutput,'utf8')),preserved:true});
  writeFileSync(process.argv[2], JSON.stringify(cards));
} finally {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
}
