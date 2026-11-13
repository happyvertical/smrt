/** Two-package cold-process fixture. Run after building smrt-core. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--child')) {
  const rows = [];
  for (const gated of [false, true]) {
    const started = performance.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', ...(gated ? ['--gated'] : [])], {
        env: { ...process.env, SMRT_DEFAULT_AI_PROVIDER: 'none' },
      });
      let output = ''; let errors = ''; let ready;
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (ready === undefined && output.includes('a3-ready\n')) ready = Math.round(performance.now() - started);
      });
      child.stderr.on('data', (chunk) => { errors += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0 || ready === undefined) { reject(new Error(errors || output)); return; }
        resolve({ mode: gated ? 'gated' : 'baseline', coldStartMs: ready, ...JSON.parse(output.trim().split('\n').at(-1)) });
      });
    });
    rows.push(result);
  }
  console.log(JSON.stringify(rows, null, 2));
} else {
  const { ObjectRegistry, SmrtObject, SmrtCollection, APIGenerator } = await import('../dist/index.js');
  const { createCookbookEngine } = await import('../dist/cookbook/engine.js');
  const { createCookbookRuntimeExposure, setRuntimeExposureGate } = await import('../dist/runtime-exposure.js');
  const { migrateSmrtSchemas } = await import('../dist/migrations.js');
  const { getDatabase } = await import('@happyvertical/sql');
  ObjectRegistry.clear();
  class Customer extends SmrtObject {}
  class Estimate extends SmrtObject {}
  class Customers extends SmrtCollection { static _itemClass = Customer; }
  class Estimates extends SmrtCollection { static _itemClass = Estimate; }
  const CUSTOMER = '@fixture/customers:Customer';
  const ESTIMATE = '@fixture/estimates:Estimate';
  ObjectRegistry.register(Customer, { packageName: '@fixture/customers', tableName: 'fixture_customers', api: { public: true } });
  ObjectRegistry.register(Estimate, { packageName: '@fixture/estimates', tableName: 'fixture_estimates', api: { public: true } });
  ObjectRegistry.registerCollection(CUSTOMER, Customers);
  ObjectRegistry.registerCollection(ESTIMATE, Estimates);
  const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  let gate;
  try {
    await migrateSmrtSchemas({ db, packageName: '@fixture/app', engineHint: 'sqlite' });
    if (process.argv.includes('--gated')) {
      const catalog = { models: [{ id: CUSTOMER, name: 'Customer', packageId: 'customers', exposed: true }, { id: ESTIMATE, name: 'Estimate', packageId: 'estimates', exposed: true }], recipes: [] };
      const engine = createCookbookEngine({ catalog });
      engine.run({ name: 'add_features', input: { ids: [CUSTOMER] } });
      gate = createCookbookRuntimeExposure({ catalog, engineFor: () => engine });
      setRuntimeExposureGate(gate);
    }
    const handler = new APIGenerator({ basePath: '/api' }, { db, tenantId: 'fixture' }).generateHandler();
    const response = await handler(new Request('http://fixture/api/customers'));
    if (response.status !== 200) throw new Error(`Fixture health: ${response.status}`);
    console.log('a3-ready');
    const disabled = await handler(new Request('http://fixture/api/estimates'));
    const { rows: tables } = await db.query("SELECT name FROM sqlite_master WHERE type = 'table'");
    console.log(JSON.stringify({ tableCount: tables.length, applicationTableCount: tables.filter((row) => row.name.startsWith('fixture_')).length, rssMiB: Math.round(process.memoryUsage().rss / 1048576 * 100) / 100, estimateStatus: disabled.status }));
  } finally { setRuntimeExposureGate(undefined); gate?.dispose(); await db.close?.(); }
}
