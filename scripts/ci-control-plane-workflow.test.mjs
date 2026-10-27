import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/on-pull-request.yml', import.meta.url),
  'utf8',
);

function job(name) {
  const match = workflow.match(
    new RegExp(
      `^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`,
      'm',
    ),
  );
  assert.ok(match, `workflow job ${name} must exist`);
  return match[0];
}

test('control-plane tests use the trusted test-suite admission and installed project toolchain', () => {
  const controlPlane = job('ci-control-plane');
  const admission = (source) =>
    source.match(/^    if: >-\n([\s\S]*?)(?=^    \S)/m)?.[1];
  assert.ok(admission(controlPlane));
  assert.equal(admission(controlPlane), admission(job('test')));
  assert.match(
    admission(controlPlane),
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(admission(controlPlane), /github\.event_name == 'merge_group'/);
  assert.match(controlPlane, /^    runs-on: ubuntu-latest$/m);
  assert.match(controlPlane, /ref: \$\{\{ env\.CHECKOUT_REF \}\}/);
  assert.match(controlPlane, /uses: \.\/\.github\/actions\/setup-environment/);
  assert.match(controlPlane, /node-version: '26\.12\.1'/);
  assert.match(controlPlane, /install-deps: 'true'/);
  assert.match(controlPlane, /setup-playwright: 'false'/);
  assert.match(controlPlane, /pnpm turbo run build --filter='@happyvertical\/smrt-core\^\.\.\.'/);
  assert.match(controlPlane, /run: pnpm test:ci-scripts/);
  assert.doesNotMatch(
    controlPlane,
    /continue-on-error|paths-filter|pnpm (?:run )?build/,
  );
  const root = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(root.scripts['test:ci-scripts'], 'node --test scripts/*.test.mjs');
});

test('Required CI rejects a failed, cancelled, skipped or absent control-plane result', () => {
  const required = job('required-ci');
  assert.match(required, /if: always\(\)/);
  assert.match(required, /^      - ci-control-plane$/m);
  assert.match(
    required,
    /CI_CONTROL_PLANE: \$\{\{ needs\.ci-control-plane\.result \}\}/,
  );

  // Execute the actual aggregate shell with all other jobs successful. This
  // catches a result wired into env but accidentally omitted from the gate.
  const command = required.match(/^        run: \|\n([\s\S]*)/m)?.[1];
  assert.ok(command);
  const script = command.replace(/^          /gm, '');
  const successful = {};
  const resultVariables = required.matchAll(
    /^          ([A-Z_]+): \$\{\{ needs\.[^\n]+\.result \}\}$/gm,
  );
  for (const match of resultVariables) {
    successful[match[1]] = 'success';
  }
  Object.assign(successful, {
    EVENT_NAME: 'pull_request_target',
    PUBLISH_DRY_RUN: 'skipped',
    VISUAL_SELECTED: 'false',
    VISUAL_RESULT: 'skipped',
    PLANNER_SELECTED: 'false',
    PLANNER_RESULT: 'skipped',
  });
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const run = spawnSync('bash', ['-c', script], {
      env: { ...successful, CI_CONTROL_PLANE: result },
      encoding: 'utf8',
    });
    assert.equal(run.error, undefined);
    assert.equal(
      run.status === 0,
      result === 'success',
      `${result || 'absent'}: ${run.stdout}${run.stderr}`,
    );
  }
});
