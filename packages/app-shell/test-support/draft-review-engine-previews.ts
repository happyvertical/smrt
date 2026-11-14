// Real publish rehearsals for DOM tests; browser conditions cannot boot models.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppHost, type Command, MemoryVersionStore } from '../src/engine/index.ts';
import { versionSummary } from '../src/lib/ui/command-summary.ts';

const dir = mkdtempSync(join(tmpdir(), 'draft-review-engine-'));
const live = await AppHost.open(join(dir, 'live'), { store: new MemoryVersionStore() });
let draft: AppHost | undefined;
try {
  await live.execute({ type: 'defineModel', name: 'Order', label: 'Orders', fields: {
    name: { type: 'text' }, notes: { type: 'text' }, quantity: { type: 'integer', label: 'Quantity' }, price: { type: 'integer' },
    total: { type: 'integer', label: 'Total', calculated: { op: 'mul', left: { col: 'quantity' }, right: { col: 'price' } } },
  } }, { author: 'owner' });
  await live.create('Order', { name: 'Existing', quantity: 2, price: 4 });
  draft = await live.forkDraft(join(dir, 'draft'), { store: new MemoryVersionStore() });
  const execute = (command: Command) => draft!.execute(command, { author: 'owner' });
  await execute({ type: 'loadRecords', model: 'Order', mode: 'insert', rows: [{ name: 'Loaded', quantity: 3, price: 5 }] });
  await execute({ type: 'renameField', model: 'Order', from: 'quantity', to: 'units' });
  async function preview() {
    const result = await live.previewPublish(draft!);
    const chain = await draft!.draftChain();
    const records = new Map([chain.base, ...chain.versions].map((v) => [v.version, v]));
    return {
      ...result,
      fields: Object.fromEntries(Object.entries(draft!.describe().models).map(([name, m]) => [name, { ...live.describe().models[name]?.fields, ...m.fields }])),
      modelLabels: { Order: 'Orders' },
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
  writeFileSync(process.argv[2], JSON.stringify({ renamed, differingLabels, formulaChanged, archived }));
} finally {
  await draft?.close();
  await live.close();
  rmSync(dir, { recursive: true, force: true });
}
