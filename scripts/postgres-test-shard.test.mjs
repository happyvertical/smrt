import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { INGESTION, parsePostgresShard, readPostgresManifests, selectPostgresShard } from './postgres-test-shard.mjs';
import { parseTurboDryRun } from './affected-test-shard.mjs';

const suite = (name) => ({ name, scripts: { 'test:postgres': 'run-test' } });
const root = fileURLToPath(new URL('../', import.meta.url));

test('partition is exhaustive, disjoint, deterministic and automatically includes new suites', () => {
  const manifests = [suite('z-new'), suite(INGESTION), { name: 'no-suite' }, suite('a-suite')];
  const ingestion = selectPostgresShard(manifests, 'ingestion');
  const remaining = selectPostgresShard(manifests, 'remaining');
  assert.deepEqual(ingestion.selected, [INGESTION]);
  assert.deepEqual(remaining.selected, ['a-suite', 'z-new']);
  assert.deepEqual([...ingestion.selected, ...remaining.selected].sort(), ingestion.registered);
  assert.deepEqual(selectPostgresShard([...manifests].reverse(), 'remaining'), remaining);
});

test('balanced groups of the remaining suites are exhaustive and disjoint (#5045)', () => {
  const manifests = [suite(INGESTION), ...['a', 'b', 'c', 'd', 'e'].map(suite)];
  const groups = ['remaining:1/3', 'remaining:2/3', 'remaining:3/3'].map((shard) => selectPostgresShard(manifests, shard));
  assert.deepEqual(groups.flatMap((group) => group.selected).sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.ok(groups.every((group) => group.vitestArgs.length === 0));
  assert.deepEqual(selectPostgresShard([...manifests].reverse(), 'remaining:2/3'), groups[1]);
});

test('an ingestion slice keeps the one package and hands Vitest the file slice', () => {
  const manifests = [suite(INGESTION), suite('other')];
  assert.deepEqual(selectPostgresShard(manifests, 'ingestion').vitestArgs, []);
  const slice = selectPostgresShard(manifests, 'ingestion:2/2');
  assert.deepEqual(slice.selected, [INGESTION]);
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
    assert.deepEqual(selectPostgresShard(manifests, 'remaining').selected, ['nested-host']);
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
      assert.deepEqual(selected, [INGESTION]);
      slices.push(`${index}/${count}`);
      if (index > 1) continue;
    }
    const output = execFileSync('pnpm', ['turbo', 'run', 'test:postgres', '--dry=json', ...selected.map((name) => `--filter=${name}`)], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const tasks = parseTurboDryRun(output).tasks.filter((task) => task.task === 'test:postgres').map((task) => task.package).sort();
    assert.deepEqual(tasks, selected, `Turbo must not implicitly pull PostgreSQL suites into ${shard}`);
    executed.push(...tasks);
  }
  const sliceCount = Number(slices[0]?.split('/')[1]);
  assert.deepEqual(slices.sort(), Array.from({ length: sliceCount }, (_, i) => `${i + 1}/${sliceCount}`), 'Ingestion file slices must be complete');
  assert.equal(new Set(executed).size, executed.length, 'No PostgreSQL suite may run twice');
  assert.deepEqual(executed.sort(), all);
});
