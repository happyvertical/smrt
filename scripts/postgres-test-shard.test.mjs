import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { INGESTION, parsePostgresShard, readPostgresManifests, selectPostgresShard, uncoveredPostgresPackages } from './postgres-test-shard.mjs';
import { expandPostgresUnits, POSTGRES_TEST_SECONDS, SPLIT_POSTGRES_UNITS, unitPackage } from './test-shard-balance.mjs';
import { parseTurboDryRun } from './affected-test-shard.mjs';

const suite = (name) => ({ name, scripts: { 'test:postgres': 'run-test' } });
const root = fileURLToPath(new URL('../', import.meta.url));
const CORE = '@happyvertical/smrt-core';
const unit = (name) => `${name}#test:postgres`;
const coreSuite = () => ({
  name: CORE,
  scripts: { 'test:postgres': 'aggregate', 'test:postgres:real': 'real', 'test:postgres:pglite': 'pglite' },
});

test('partition is exhaustive, disjoint, deterministic and automatically includes new suites', () => {
  const manifests = [suite('z-new'), suite(INGESTION), { name: 'no-suite' }, suite('a-suite')];
  const ingestion = selectPostgresShard(manifests, 'ingestion');
  const remaining = selectPostgresShard(manifests, 'remaining');
  assert.deepEqual(ingestion.selected, [unit(INGESTION)]);
  assert.deepEqual(remaining.selected, [unit('a-suite'), unit('z-new')]);
  assert.deepEqual([...ingestion.selected, ...remaining.selected].sort(), ingestion.registered.map(unit));
  assert.deepEqual(selectPostgresShard([...manifests].reverse(), 'remaining'), remaining);
});

test('balanced groups of the remaining suites are exhaustive and disjoint (#5045)', () => {
  const manifests = [suite(INGESTION), ...['a', 'b', 'c', 'd', 'e'].map(suite)];
  const groups = ['remaining:1/3', 'remaining:2/3', 'remaining:3/3'].map((shard) => selectPostgresShard(manifests, shard));
  assert.deepEqual(groups.flatMap((group) => group.selected).sort(), ['a', 'b', 'c', 'd', 'e'].map(unit));
  assert.ok(groups.every((group) => group.vitestArgs.length === 0));
  assert.deepEqual(selectPostgresShard([...manifests].reverse(), 'remaining:2/3'), groups[1]);
});

test('an ingestion slice keeps the one package and hands Vitest the file slice', () => {
  const manifests = [suite(INGESTION), suite('other')];
  assert.deepEqual(selectPostgresShard(manifests, 'ingestion').vitestArgs, []);
  const slice = selectPostgresShard(manifests, 'ingestion:2/2');
  assert.deepEqual(slice.selected, [unit(INGESTION)]);
  assert.deepEqual(slice.vitestArgs, ['--shard=2/2']);
});

test('missing ingestion, empty shards, invalid shard and unsafe manifests fail closed', () => {
  for (const shard of ['remaining:0/3', 'remaining:4/3', 'ingestion:1', 'ingestion:1/2/3', 'other:1/2', '']) {
    assert.throws(() => parsePostgresShard(shard), /Invalid PostgreSQL shard/, shard);
  }
  assert.throws(() => selectPostgresShard([suite(INGESTION), suite('only')], 'remaining:2/2'), /empty/);
  assert.throws(() => selectPostgresShard([suite('other')], 'remaining'), /ingestion.*missing/);
  assert.throws(() => selectPostgresShard([suite(INGESTION)], 'remaining'), /empty/);
  assert.throws(() => selectPostgresShard([suite(INGESTION)], '1/2'), /Invalid PostgreSQL shard/);
  assert.throws(() => selectPostgresShard([], 'ingestion'), /no workspace/);
  assert.throws(() => selectPostgresShard([suite(INGESTION), suite(INGESTION)], 'ingestion'), /duplicate/);
  assert.throws(() => selectPostgresShard([suite(INGESTION), suite('unsafe --filter=*')], 'ingestion'), /Invalid/);
  assert.throws(() => selectPostgresShard([suite(INGESTION), { name: 'bad', scripts: { 'test:postgres': '' } }], 'ingestion'), /Invalid test:postgres/);
});

test('pnpm discovery includes nested and nonstandard workspace roots', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'smrt-pg-workspaces-'));
  try {
    writeFileSync(join(fixture, 'pnpm-workspace.yaml'), "packages:\n  - 'modules/*'\n  - 'apps/host/nested'\n");
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'root', private: true }));
    for (const [path, manifest] of [['modules/ingestion', suite(INGESTION)], ['apps/host/nested', suite('nested-host')]]) {
      mkdirSync(dirname(join(fixture, path, 'package.json')), { recursive: true });
      writeFileSync(join(fixture, path, 'package.json'), JSON.stringify(manifest));
    }
    const manifests = await readPostgresManifests(fixture);
    assert.deepEqual(selectPostgresShard(manifests, 'remaining').selected, [unit('nested-host')]);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('current registered suites run exactly once, including Turbo dependency expansion', async () => {
  const manifests = await readPostgresManifests(root);
  const all = selectPostgresShard(manifests, 'ingestion').registered;
  assert.ok(all.length >= 33, `Expected the current 33 registered suites, found ${all.length}`);
  // The lane's real matrix: every remaining suite once, and ingestion once per
  // file slice, with the slices of one count complete.
  const workflow = readFileSync(join(root, '.github/workflows/postgres-tests.yml'), 'utf8');
  const matrix = /^ {8}shard: \[(.+)\]$/m.exec(workflow)?.[1].split(',').map((entry) => entry.trim().replace(/^'|'$/g, ''));
  assert.ok(matrix, 'postgres-tests.yml must declare its shard matrix inline');
  const executed = [];
  const slices = [];
  for (const shard of matrix) {
    const { group, index, count } = parsePostgresShard(shard);
    const { selected } = selectPostgresShard(manifests, shard);
    if (group === 'ingestion') {
      assert.deepEqual(selected, [unit(INGESTION)]);
      slices.push(`${index}/${count}`);
      if (index > 1) continue;
    }
    const output = execFileSync('pnpm', ['turbo', 'run', '--dry=json', ...selected], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const tasks = parseTurboDryRun(output).tasks.filter((task) => task.task.startsWith('test:postgres')).map((task) => `${task.package}#${task.task}`).sort();
    assert.deepEqual(tasks, selected, `Turbo must not implicitly pull PostgreSQL suites into ${shard}`);
    executed.push(...tasks);
  }
  const sliceCount = Number(slices[0]?.split('/')[1]);
  assert.deepEqual(slices.sort(), Array.from({ length: sliceCount }, (_, i) => `${i + 1}/${sliceCount}`), 'Ingestion file slices must be complete');
  assert.equal(new Set(executed).size, executed.length, 'No PostgreSQL suite may run twice');
  assert.deepEqual(executed.sort(), expandPostgresUnits(all));
  // Core's aggregate `test:postgres` is the local script, never a CI unit.
  assert.ok(!executed.includes(unit(CORE)), 'core aggregate must not be scheduled beside its halves');
});

test('an affected list restricts each shard without moving the grouping (#5364)', () => {
  const manifests = [suite(INGESTION), ...['a', 'b', 'c', 'd', 'e'].map(suite)];
  const full = selectPostgresShard(manifests, 'remaining:1/3');
  const only = [full.selected[0], 'unregistered#test:postgres'];
  assert.deepEqual(selectPostgresShard(manifests, 'remaining:1/3', only.map(unitPackage)).selected, [full.selected[0]]);
  assert.deepEqual(selectPostgresShard(manifests, 'remaining:1/3', []).selected, []);
  assert.deepEqual(selectPostgresShard(manifests, 'ingestion:2/2', [INGESTION]).vitestArgs, ['--shard=2/2']);
  assert.deepEqual(selectPostgresShard(manifests, 'ingestion:2/2', ['a']).vitestArgs, []);
  assert.throws(() => selectPostgresShard(manifests, 'remaining', 'a'), /array of names/);
  assert.deepEqual(selectPostgresShard(manifests, 'remaining:1/3', undefined), full);
});

test('affecting core selects BOTH of its halves, matched on the owning package (#5649)', () => {
  const manifests = [suite(INGESTION), coreSuite(), ...['a', 'b', 'c', 'd', 'e'].map(suite)];
  const halves = SPLIT_POSTGRES_UNITS[CORE].map((task) => `${CORE}#${task}`);
  const selected = [1, 2, 3].flatMap((i) => selectPostgresShard(manifests, `remaining:${i}/3`, [CORE]).selected);
  assert.deepEqual(selected.sort(), halves.sort());
  const none = [1, 2, 3].flatMap((i) => selectPostgresShard(manifests, `remaining:${i}/3`, ['a']).selected);
  assert.deepEqual(none, [unit('a')]);
  // Without an affected list, core's halves land on different shards.
  const homes = halves.map((half) => [1, 2, 3].find((i) => selectPostgresShard(manifests, `remaining:${i}/3`).selected.includes(half)));
  assert.ok(homes.every(Boolean) && homes[0] !== homes[1], `halves share a shard: ${homes}`);
});

test('the union of units is every test:postgres package plus both core halves, from package.json (#5649)', async () => {
  const manifests = await readPostgresManifests(root);
  const withScript = manifests.filter((m) => typeof m.scripts?.['test:postgres'] === 'string').map((m) => m.name).sort();
  assert.ok(withScript.includes(CORE) && withScript.includes('@happyvertical/smrt-app-shell'));
  const shards = ['ingestion', 'remaining:1/3', 'remaining:2/3', 'remaining:3/3'];
  const units = shards.flatMap((shard) => selectPostgresShard(manifests, shard).selected).sort();
  const expected = withScript
    .flatMap((name) => (name === CORE ? [`${CORE}#test:postgres:pglite`, `${CORE}#test:postgres:real`] : [unit(name)]))
    .sort();
  assert.deepEqual(units, expected);
  assert.equal(new Set(units).size, units.length, 'no unit may run twice');
  // Every unit has a weight source: its own id, or its package (a plain unit).
  for (const half of SPLIT_POSTGRES_UNITS[CORE]) assert.ok(POSTGRES_TEST_SECONDS[`${CORE}#${half}`] > 0, half);
  assert.ok(POSTGRES_TEST_SECONDS['@happyvertical/smrt-app-shell'] > 100, 'app-shell must be weighed');
  assert.equal(POSTGRES_TEST_SECONDS[CORE], undefined, 'core has no whole-package weight once split');
});

test('a test:postgres package in no unit fails; a split package missing a half fails (#5649)', () => {
  assert.deepEqual(uncoveredPostgresPackages(['a', 'b'], ['a#test:postgres']), ['b']);
  assert.deepEqual(uncoveredPostgresPackages(['a', 'b'], expandPostgresUnits(['a', 'b'])), []);
  for (const missing of ['test:postgres:real', 'test:postgres:pglite']) {
    const broken = coreSuite();
    delete broken.scripts[missing];
    assert.throws(() => selectPostgresShard([suite(INGESTION), broken, suite('a')], 'remaining'), new RegExp(`Missing ${missing}`));
  }
});
