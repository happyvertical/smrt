import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { INGESTION, readPostgresManifests, selectPostgresShard } from './postgres-test-shard.mjs';
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

test('missing ingestion, empty shards, invalid shard and unsafe manifests fail closed', () => {
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
  const executed = [];
  for (const shard of ['ingestion', 'remaining']) {
    const { selected } = selectPostgresShard(manifests, shard);
    const output = execFileSync('pnpm', ['turbo', 'run', 'test:postgres', '--dry=json', ...selected.map((name) => `--filter=${name}`)], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const tasks = parseTurboDryRun(output).tasks.filter((task) => task.task === 'test:postgres').map((task) => task.package).sort();
    assert.deepEqual(tasks, selected, `Turbo must not implicitly pull PostgreSQL suites into ${shard}`);
    executed.push(...tasks);
  }
  assert.equal(new Set(executed).size, executed.length, 'No PostgreSQL suite may run twice');
  assert.deepEqual(executed.sort(), all);
});
