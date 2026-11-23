// Real publish rehearsals for DOM tests; browser conditions cannot boot models.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppHost, type Command, MemoryVersionStore } from '../src/engine/index.ts';
import { hostOwner } from '../src/test/engine-principal.ts';
import { versionSummary } from '../src/lib/ui/command-summary.ts';

const dir = mkdtempSync(join(tmpdir(), 'draft-review-engine-'));
const live = await AppHost.open(join(dir, 'live'), { store: new MemoryVersionStore() });
let draft: AppHost | undefined;
try {
  await live.execute({ type: 'defineModel', name: 'Order', label: 'Orders', fields: {
    name: { type: 'text' }, legacyField: { type: 'text', label: 'Previous reference' }, rating: { type: 'text', label: 'Customer rating' }, notes: { type: 'text' }, quantity: { type: 'integer', label: 'Quantity' }, price: { type: 'integer' },
    total: { type: 'integer', label: 'Total', calculated: { op: 'mul', left: { col: 'quantity' }, right: { col: 'price' } } },
  } }, { author: 'owner', approved: true });
  await live.create(hostOwner(live), 'Order', { name: 'Existing', quantity: 2, price: 4, rating: '5', legacyField: 'kept for undo' });
  await live.execute({ type: 'addMethod', model: 'Order', name: 'showTotal', method: { description: 'Show the saved total', code: 'return { result: record.total };' } }, { author: 'owner', approved: true });
  await live.execute({ type: 'addMethod', model: 'Order', name: 'rebuildSummary', method: { description: 'Old summary', code: 'return { result: 1 };' } }, { author: 'owner', approved: true });
  await live.execute({ type: 'defineModel', name: 'RetiredContact', label: 'Retired contacts', fields: { name: { type: 'text' } } }, { author: 'owner', approved: true });
  await live.create(hostOwner(live), 'RetiredContact', { name: 'Earlier customer' });
  draft = await live.forkDraft(join(dir, 'draft'), { store: new MemoryVersionStore() });
  const execute = (command: Command) => draft!.execute(command, { author: 'owner', approved: true });
  await execute({ type: 'loadRecords', model: 'Order', mode: 'insert', rows: [{ name: 'Loaded', quantity: 3, price: 5 }] });
  await execute({ type: 'renameField', model: 'Order', from: 'quantity', to: 'units' });
  async function preview() {
    const result = await live.previewPublish(draft!);
    const chain = await draft!.draftChain();
    const records = new Map([chain.base, ...chain.versions].map((v) => [v.version, v]));
    const descriptions = { ...live.describe().models, ...draft!.describe().models };
    const relevantModels = new Set([...Object.keys(result.definition.models), ...result.definition.modelsAdded, ...result.definition.modelsRemoved, ...result.methods.map((method) => method.model)]);
    return {
      ...result,
      fields: Object.fromEntries(Object.entries(draft!.describe().models).map(([name, m]) => [name, { ...live.describe().models[name]?.fields, ...m.fields }])),
      modelLabels: Object.fromEntries([...relevantModels].map((name) => [name, descriptions[name]?.label ?? name])),
      versions: result.versions.map((v) => {
        const record = records.get(v.draftVersion)!;
        return { ...v, humanSummary: versionSummary(record.summary, records.get(record.parent!)?.definition, record.definition) };
      }),
    };
  }
  const renamed = await preview();
  await execute({ type: 'renameField', model: 'Order', from: 'notes', to: 'memo' });
  const differingLabels = await preview();
  await execute({ type: 'setCalculation', model: 'Order', field: 'total', calculated: { op: 'mul', left: { col: 'units' }, right: { value: 10 } } });
  const formulaChanged = await preview();
  await execute({ type: 'removeField', model: 'Order', field: 'price' });
  const archived = await preview();
  await execute({ type: 'changeFieldType', model: 'Order', field: 'rating', to: { type: 'integer', label: 'Customer rating' } });
  await execute({ type: 'removeField', model: 'Order', field: 'legacyField' });
  await execute({ type: 'removeModel', model: 'RetiredContact' });
  await execute({ type: 'defineModel', name: 'Shipment', label: 'Deliveries', fields: { title: { type: 'text' } } });
  await execute({ type: 'addField', model: 'Order', field: 'promisedDate', definition: { type: 'text', label: 'Promised date' } });
  await execute({ type: 'addMethod', model: 'Order', name: 'recalculateTotal', method: { description: 'Recalculate the saved total', code: 'return { result: 10 };' } });
  await execute({ type: 'addMethod', model: 'Order', name: 'rebuildSummary', method: { description: 'Rebuild the saved summary', code: 'return { result: 2 };' } });
  const allLabels = await preview();
  writeFileSync(process.argv[2], JSON.stringify({ renamed, differingLabels, formulaChanged, archived, allLabels }));
} finally {
  await draft?.close();
  await live.close();
  rmSync(dir, { recursive: true, force: true });
}
