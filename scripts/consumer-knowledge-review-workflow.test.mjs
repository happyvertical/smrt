import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The reusable workflow runs in a consumer repo, so its path guard stays
// inline. This test extracts the real `run:` script and executes it (#4690).
const workflow = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
  'consumer-knowledge-review.yml',
);

function extractRunScript() {
  const lines = readFileSync(workflow, 'utf8').split('\n');
  const step = lines.findIndex((line) => line.includes('name: Run duplicate detection'));
  const start = lines.findIndex((line, i) => i > step && /^\s+run: \|\s*$/.test(line));
  assert.ok(step >= 0 && start > step, 'run step not found');
  const indent = lines[start + 1].match(/^ */)[0].length;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

function runGuard(t, consumerPath, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-wf-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const argsFile = join(root, 'npx-args');
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho stub-summary\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  const script = join(root, 'step.sh');
  writeFileSync(script, extractRunScript());
  const temp = join(root, 'tmp');
  mkdirSync(temp);
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_WORKSPACE: join(root, 'ws'),
      RUNNER_TEMP: temp,
      GITHUB_STEP_SUMMARY: join(root, 'summary'),
      SMRT_VERSION: '0.61.0',
      FAIL_ON_FINDINGS: 'false',
      CONSUMER_PATH: consumerPath,
      ...extraEnv,
    },
  });
  let npxArgs = null;
  try {
    npxArgs = readFileSync(argsFile, 'utf8');
  } catch {}
  return { ...result, npxArgs, root };
}

test('default invocation (empty consumer-path) reaches npx without an intent index', (t) => {
  const result = runGuard(t, '');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.npxArgs, /smrt-dev-mcp@0\.61\.0/);
  assert.match(result.npxArgs, /--directory\n.*\/ws\/\.\n/);
  assert.doesNotMatch(result.npxArgs, /--intent-index/);
  assert.match(readFileSync(join(result.root, 'summary'), 'utf8'), /stub-summary/);
});

for (const ok of ['.', 'a/b', 'apps/web']) {
  test(`accepts consumer-path ${JSON.stringify(ok)}`, (t) => {
    const result = runGuard(t, ok);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.npxArgs, 'npx should run');
  });
}

for (const bad of ['..', 'a/../b', '../x', 'a/..', '/abs', '//abs']) {
  test(`rejects consumer-path ${JSON.stringify(bad)} before running npx`, (t) => {
    const result = runGuard(t, bad);
    assert.equal(result.status, 2);
    assert.equal(result.npxArgs, null);
    assert.match(result.stderr, /consumer-path must be relative/);
  });
}

test('rejects a non-exact smrt-version', (t) => {
  const result = runGuard(t, '', { SMRT_VERSION: '^0.61.0' });
  assert.equal(result.status, 2);
  assert.equal(result.npxArgs, null);
});

test('passes --fail-on-findings only when requested', (t) => {
  const result = runGuard(t, '', { FAIL_ON_FINDINGS: 'true' });
  assert.match(result.npxArgs, /--fail-on-findings/);
});
