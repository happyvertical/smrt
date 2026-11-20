// Child process for worker-loads.test.ts: starts ONE app worker through the
// real handle, serves it, and exits. Its main thread imports only the handle
// (not the host), so the load log's reports entries come from the worker.
//   argv: <workerEntry> <dataDir> [report]
import { AppWorker } from '../src/engine/worker-handle.ts';

const [entry, dataDir, mode] = process.argv.slice(2);
const def = {
  format: 1 as const,
  name: 'loads',
  recipes: [],
  models: { Chore: { fields: { title: { type: 'text' as const } } } },
};
const worker = new AppWorker(entry, { dataDir, def, version: 1 });
await worker.ready;
const row = await worker.call<{ id: string }>('create', 'Chore', {
  title: 'kept',
});
await worker.call('get', 'Chore', row.id);
await worker.call('list', 'Chore');
if (mode === 'report') {
  await worker.call('runReport', {
    version: 1,
    title: 'Chores',
    source: 'Chore',
    dimensions: [],
    measures: [{ fn: 'count', as: 'n' }],
  }, { maxRows: 10 });
}
await worker.retire();
process.exit(0);
