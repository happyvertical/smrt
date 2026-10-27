import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
function job(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `missing job ${name}`);
  return match[0];
}
function resolve(value, context) {
  return value.replace(/\$\{\{ ([\w.-]+) \}\}/g, (_, path) => {
    const result = path.split('.').reduce((current, key) => current?.[key], context);
    assert.notEqual(result, undefined, `missing output ${path}`);
    return result;
  });
}
function outputMap(source, context) {
  const block = source.match(/^    outputs:\n([\s\S]*?)(?=^    \S)/m)?.[1];
  assert.ok(block, 'producer must expose its own outputs');
  return Object.fromEntries([...block.matchAll(/^      ([\w-]+): (.*)$/gm)]
    .map(([, key, value]) => [key, resolve(value, context)]));
}
function fixture(attempts = [1, 1, 1]) {
  const needs = {};
  for (const [index, name] of ['prepare-release', 'pack-release-1', 'pack-release-2'].entries()) {
    const attempt = attempts[index];
    const upload = (offset) => ({ outputs: { 'artifact-id': String(index * 100 + attempt * 10 + offset), 'artifact-digest': `${index + 1}`.repeat(64) } });
    needs[name] = { result: 'success', outputs: outputMap(job(name), {
      github: { run_attempt: attempt },
      steps: { prepare: { outputs: { previous_version: '0.57.28', should_publish: 'true', version: '0.57.29' } },
        'upload-patch': upload(1), 'upload-workspace': upload(2), 'upload-packs': upload(1) },
    }) };
  }
  return needs;
}
function aggregate(needs, { attempt = 2, flag = '' } = {}) {
  const source = job('validate-release-shards');
  assert.match(source, /if: always\(\)/);
  const shell = source.match(/^        run: \|\n([\s\S]*?)(?=^      - |(?![\s\S]))/m)?.[1].replace(/^          /gm, '');
  assert.ok(shell, 'aggregate must check results and output identities');
  const env = Object.fromEntries([...source.matchAll(/^          ([A-Z_0-9]+): (.*)$/gm)]
    .map(([, key, value]) => [key, resolve(value, { needs, github: { run_attempt: attempt }, vars: { CI_RELEASE_WINDOW_ENABLED: flag } })]));
  const scratch = mkdtempSync(join(tmpdir(), 'release-retry-'));
  try {
    const output = join(scratch, 'outputs');
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', shell], { env: { ...process.env, ...env, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    return { ...result, outputs: result.status === 0 && existsSync(output) ? Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('='))) : {} };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
function downloadedIds(name, needs, attempt) {
  const source = job(name);
  const downloads = [...source.matchAll(/uses: actions\/download-artifact@[^\n]+\n        with:\n([\s\S]*?)(?=^      - |(?![\s\S]))/gm)];
  assert.ok(downloads.length > 0);
  return downloads.flatMap(([, options]) => {
    assert.doesNotMatch(options, /^          (?:name|pattern):/m, 'consumer must use exact producer IDs');
    const ids = options.match(/^          artifact-ids: (.*(?:\n            .*)*)/m)?.[1];
    const selection = ids?.replace(/^>-\n/, '').trim();
    assert.ok(selection, 'consumer must use artifact-ids');
    return resolve(selection, { needs, github: { run_attempt: attempt } }).split(',').map((id) => id.trim());
  });
}

test('a consumer retry locates successful attempt-1 uploads in the run inventory', () => {
  const needs = {
    'prepare-release': { outputs: { 'workspace-artifact-id': '12' } },
    'validate-release-shards': { outputs: { 'pack-1-artifact-id': '111', 'pack-2-artifact-id': '211' } },
  };
  const inventory = [
    { id: '12', name: 'publish-release-workspace-30-1' },
    { id: '111', name: 'publish-release-pack-30-1-1' },
    { id: '211', name: 'publish-release-pack-30-1-2' },
  ];
  const source = job('planner-release-gate');
  const downloads = [...source.matchAll(/uses: actions\/download-artifact@[^\n]+\n        with:\n([\s\S]*?)(?=^      - |(?![\s\S]))/gm)];
  const context = { needs, github: { run_id: 30, run_attempt: 2 } };
  const selected = downloads.flatMap(([, options]) => {
    const byName = options.match(/^          name: (.*)$/m)?.[1];
    if (byName) {
      const name = resolve(byName, context);
      const artifact = inventory.find((entry) => entry.name === name);
      assert.ok(artifact, `consumer attempt 2 cannot find successful producer upload ${name}`);
      return artifact.id;
    }
    assert.doesNotMatch(options, /^          pattern:/m, 'wildcards cannot identify exact producers');
    const ids = options.match(/^          artifact-ids: (.*(?:\n            .*)*)/m)?.[1];
    assert.ok(ids);
    return resolve(ids.replace(/^>-\n/, '').trim(), context).split(',').map((id) => id.trim());
  });
  assert.deepEqual(selected, inventory.map((entry) => entry.id));
});

test('a partial pack rerun locates both new and preserved successful shard uploads', () => {
  const source = job('planner-release-gate');
  const download = source.match(/- name: Download verified package artifacts\n([\s\S]*?)(?=^      - |(?![\s\S]))/m)?.[1];
  assert.ok(download);
  const context = {
    github: { run_id: 30, run_attempt: 2 },
    needs: { 'validate-release-shards': { outputs: { 'pack-1-artifact-id': '121', 'pack-2-artifact-id': '211' } } },
  };
  const inventory = [
    { id: '121', name: 'publish-release-pack-30-2-1' },
    { id: '211', name: 'publish-release-pack-30-1-2' },
  ];
  const pattern = download.match(/^          pattern: (.*)$/m)?.[1];
  let selected;
  if (pattern) {
    const expression = new RegExp(`^${resolve(pattern, context).replaceAll('*', '.*')}$`);
    selected = inventory.filter((entry) => expression.test(entry.name)).map((entry) => entry.id);
  } else {
    const ids = download.match(/^          artifact-ids: (.*(?:\n            .*)*)/m)?.[1];
    assert.ok(ids);
    selected = resolve(ids.replace(/^>-\n/, '').trim(), context).split(',').map((id) => id.trim());
  }
  assert.deepEqual(selected, inventory.map((entry) => entry.id), 'successful pack 2 from attempt 1 must survive pack 1 retry');
});

for (const [label, attempts] of [['successful attempt-1 producers and consumer attempt 2', [1, 1, 1]], ['only failed pack 1 reruns on attempt 2', [1, 2, 1]]]) {
  test(`ordinary retry preserves exact producer identity: ${label}`, () => {
    const needs = fixture(attempts);
    const checked = aggregate(needs);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    needs['validate-release-shards'] = { result: 'success', outputs: outputMap(job('validate-release-shards'), { steps: { identity: { outputs: checked.outputs } } }) };
    const prep = needs['prepare-release'].outputs;
    const packs = [needs['pack-release-1'].outputs['artifact-id'], needs['pack-release-2'].outputs['artifact-id']];
    for (const name of ['pack-release-1', 'pack-release-2']) {
      assert.deepEqual(downloadedIds(name, needs, 2), [prep['workspace-artifact-id']]);
    }
    assert.deepEqual(downloadedIds('planner-release-gate', needs, 2), [prep['workspace-artifact-id'], ...packs]);
    for (const publisher of ['publish-release', 'seal-release']) assert.deepEqual(downloadedIds(publisher, needs, 2), [prep['patch-artifact-id'], prep['workspace-artifact-id'], ...packs]);
    assert.equal(new Set(packs).size, 2, 'separate pack producers cannot collide');
  });
}

test('release aggregate rejects failed, cancelled, skipped and absent producer results or identities', () => {
  for (const name of ['prepare-release', 'pack-release-1', 'pack-release-2']) {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      const needs = fixture(); needs[name].result = result;
      assert.notEqual(aggregate(needs).status, 0, `${name}: ${result}`);
    }
    for (const key of Object.keys(fixture()[name].outputs).filter((key) => /artifact|attempt/.test(key))) {
      for (const value of ['', 'malformed']) {
        const needs = fixture(); needs[name].outputs[key] = value;
        assert.notEqual(aggregate(needs).status, 0, `${name}: ${key}=${value}`);
      }
    }
  }
  const duplicate = fixture();
  duplicate['pack-release-2'].outputs['artifact-id'] = duplicate['pack-release-1'].outputs['artifact-id'];
  assert.notEqual(aggregate(duplicate).status, 0);
  assert.notEqual(aggregate(fixture([1, 3, 1])).status, 0, 'future producer attempt');
});

test('attempt mixing is allowed only outside the reserved release window', () => {
  assert.equal(aggregate(fixture([2, 2, 2]), { flag: 'true' }).status, 0);
  for (const attempts of [[1, 1, 1], [1, 2, 1], [2, 1, 2]]) {
    assert.equal(aggregate(fixture(attempts)).status, 0);
    assert.notEqual(aggregate(fixture(attempts), { flag: 'true' }).status, 0);
  }
});

test('reserved-window consumer guards precede all downloads without granting Planner write access', () => {
  for (const name of ['pack-release-1', 'pack-release-2', 'planner-release-gate', 'seal-release']) {
    const source = job(name);
    const guard = source.indexOf('name: Verify reserved release snapshot');
    assert.ok(guard > source.indexOf('uses: actions/checkout@'));
    assert.ok(guard < source.indexOf('uses: actions/download-artifact@'));
    const block = source.slice(guard, source.indexOf('\n      - ', guard));
    assert.match(block, /if: vars\.CI_RELEASE_WINDOW_ENABLED == 'true'/);
    assert.match(block, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.doesNotMatch(block, /RELEASE_GITHUB_TOKEN:/);
    assert.match(block, /node scripts\/release-admission\.mjs assert-window/);
  }
  const planner = job('planner-release-gate');
  assert.doesNotMatch(planner, /(?:contents|actions|pull-requests): write|HAVE_RELEASE_APP_PRIVATE_KEY/);
});


test('a successful no-release preparation needs no artifacts; missing decisions cannot pass', () => {
  const needs = fixture();
  needs['prepare-release'].outputs['should-publish'] = 'false';
  for (const name of ['pack-release-1', 'pack-release-2']) {
    needs[name].result = 'skipped';
    for (const key of Object.keys(needs[name].outputs)) needs[name].outputs[key] = '';
  }
  const result = aggregate(needs);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.outputs, {});
  needs['prepare-release'].outputs['should-publish'] = '';
  assert.notEqual(aggregate(needs).status, 0);
});
