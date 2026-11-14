// Real engine history payload produced outside jsdom's browser conditions.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppHost, type Command, MemoryVersionStore } from '../src/engine/index.ts';
import { commandSummary, versionSummary } from '../src/lib/ui/command-summary.ts';

const dir = mkdtempSync(join(tmpdir(), 'history-engine-'));
const store = new MemoryVersionStore();
const host = await AppHost.open(dir, { store });
const headings: string[] = [];
async function run(command: Command) {
  const plan = await host.plan(command);
  headings.push(commandSummary(command, host.def, undefined, plan.preview));
  return host.execute(command, { author: 'owner', approved: true });
}
try {
  await run({ type: 'defineModel', name: 'Order', label: 'Orders', fields: {
    qty: { type: 'integer', label: 'Quantity' },
    amount: { type: 'integer', label: 'Total' },
    oldValue: { type: 'text', label: 'Original value' },
    group: { type: 'text', label: 'Category' },
  } });
  await run({ type: 'loadRecords', model: 'Order', mode: 'insert', rows: [{ qty: 2, amount: 4, group: 'Food' }, { qty: 3, amount: 6, group: 'Food' }] });
  const rows = await host.list('Order');
  await run({ type: 'mergeRecords', model: 'Order', keep: String(rows[0].id), merge: [String(rows[1].id)] });
  await run({ type: 'undo' });
  await run({ type: 'setCalculation', model: 'Order', field: 'amount', calculated: { col: 'qty' } });
  await run({ type: 'undo' });
  await run({ type: 'extractModel', model: 'Order', field: 'group', into: 'Category' });
  await run({ type: 'undo' });
  await run({ type: 'renameField', model: 'Order', from: 'oldValue', to: 'renamedValue' });
  await run({ type: 'removeField', model: 'Order', field: 'renamedValue' });
  const records = await store.list();
  const versions = records.map((record) => ({
    ...record, publish: null, purged: false, current: record.version === host.version,
    humanSummary: versionSummary(record.summary, records.find((r) => r.version === record.parent)?.definition, record.definition),
  }));
  writeFileSync(process.argv[2], JSON.stringify({ versions, headings }));
} finally {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
}
