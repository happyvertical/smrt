// The compose deployment contract and the smrt-app chart cannot drift: the
// chart's starter fixture is generated from the annotated starter Compose
// file, and this test fails when either side changes without the other.
//
// Deliberately not named deployment-*.test.mjs: the SMRT chart workflow runs
// those without building packages, and this test loads packages/config/dist.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  readStarterCompose,
  renderStarterFixture,
  starterFixturePath,
  starterImages,
} from './compose-contract-fixture.mjs';

const { validateComposeDeployment, X_HAPPYVERTICAL_SCHEMA_ID } = await import(
  '../packages/config/dist/deployment.js'
);
const schema = JSON.parse(
  readFileSync(new URL('../packages/config/schemas/x-happyvertical.v1.schema.json', import.meta.url), 'utf8'),
);
const chartSchema = JSON.parse(
  readFileSync(new URL('../charts/smrt-app/values.schema.json', import.meta.url), 'utf8'),
);

test('the starter Compose file is a valid declaration as written', () => {
  const result = validateComposeDeployment(readStarterCompose());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.declaration.workloads.map(({ name, role, port }) => ({ name, role, port })),
    [
      { name: 'web', role: 'web', port: 3000 },
      { name: 'worker', role: 'worker', port: undefined },
      { name: 'schedule-worker', role: 'worker', port: undefined },
    ],
  );
  assert.deepEqual(result.declaration.bindings, [{ name: 'database', kind: 'postgres' }]);
  // The one-shot Compose migration job stays local; a platform runs the
  // declared migrate command inside the web image instead.
  assert.deepEqual(result.declaration.localOnly, ['migrate']);
  assert.equal(result.declaration.migrate.service, 'web');
});

test('the starter Compose file deploys from digests and never from build', () => {
  const built = validateComposeDeployment(readStarterCompose(), { stage: 'deploy' });
  assert.deepEqual(
    built.errors.map(({ code, service }) => `${code}:${service}`),
    ['image-not-digest:web', 'image-not-digest:worker', 'image-not-digest:schedule-worker'],
  );
  const released = validateComposeDeployment(readStarterCompose(), { stage: 'deploy', images: starterImages });
  assert.deepEqual(released.errors, []);
  assert.equal(released.declaration.migrate.image, starterImages.web);
});

test('the chart starter fixture is generated from the starter Compose file', async () => {
  assert.equal(
    readFileSync(starterFixturePath, 'utf8'),
    await renderStarterFixture(),
    'charts/smrt-app/fixtures/starter.json is stale. Run: node scripts/compose-contract-fixture.mjs --write',
  );
});

test('the generated fixture uses only fields and roles the chart schema defines', async () => {
  const values = JSON.parse(await renderStarterFixture());
  assert.deepEqual(Object.keys(values).sort(), [...chartSchema.required].sort());
  const workload = chartSchema.definitions.workload;
  for (const runtime of [values.target]) {
    for (const [name, rendered] of Object.entries(runtime.workloads)) {
      assert.ok(workload.properties.role.enum.includes(rendered.role), `${name} role`);
      for (const field of workload.required) assert.ok(field in rendered, `${name}.${field}`);
      for (const field of Object.keys(rendered)) assert.ok(field in workload.properties, `${name}.${field}`);
      assert.match(rendered.image, new RegExp(chartSchema.definitions.image.pattern));
    }
    for (const field of chartSchema.definitions.migration.required) {
      assert.ok(field in runtime.migration, `migration.${field}`);
    }
  }
  assert.equal(values.target.migration.guard, 'smrt-release-v1');
});

test('the published schema carries the id the validator names', () => {
  assert.equal(schema.$id, X_HAPPYVERTICAL_SCHEMA_ID);
});
