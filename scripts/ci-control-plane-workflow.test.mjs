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
  assert.match(controlPlane, /run: pnpm test:ci-scripts$/m);
  // Tests that load core's own dist (#4933) build it after the unbuilt lane ran.
  assert.match(controlPlane, /pnpm turbo run build --filter='@happyvertical\/smrt-core'$/m);
  assert.match(controlPlane, /run: pnpm test:ci-scripts:built-core$/m);
  assert.ok(
    controlPlane.indexOf('run: pnpm test:ci-scripts\n') <
      controlPlane.indexOf("--filter='@happyvertical/smrt-core'\n"),
    'the unbuilt lane must run before core is built',
  );
  assert.doesNotMatch(
    controlPlane,
    /continue-on-error|paths-filter|pnpm (?:run )?build/,
  );
  const root = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(root.scripts['test:ci-scripts'], 'node --import ./packages/vitest/src/test-home-register.ts --test scripts/*.test.mjs');
  assert.equal(root.scripts['test:ci-scripts:built-core'], 'node --import ./packages/vitest/src/test-home-register.ts --test scripts/built-core/*.test.mjs');
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
    EVENT_NAME: 'pull_request',
    PUBLISH_DRY_RUN: 'skipped',
    VISUAL_SELECTED: 'false',
    VISUAL_RESULT: 'skipped',
    PLANNER_SELECTED: 'false',
    PLANNER_RESULT: 'skipped',
    DOCS_SELECTED: 'false',
    DOCS_RESULT: 'skipped',
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

test('merge groups select affected or full validation from the impact plan, and keep the merge-group-only gates (#5364)', () => {
  const admission = (source) =>
    source.match(/^    if: >-\n([\s\S]*?)(?=^    \S)/m)?.[1];
  const scope = job('validation-scope');
  const suite = readFileSync(
    new URL('../.github/workflows/test-suite.yml', import.meta.url),
    'utf8',
  );
  const postgres = readFileSync(
    new URL('../.github/workflows/postgres-tests.yml', import.meta.url),
    'utf8',
  );
  assert.equal(admission(scope), admission(job('test')));
  assert.match(job('test'), /^    needs: validation-scope$/m);
  // Never a literal `full`/`affected` for merge groups; an empty output is full.
  assert.match(job('test'), /mode: \$\{\{ needs\.validation-scope\.outputs\.mode \|\| 'full' \}\}/);
  assert.match(scope, /node scripts\/merge-group-scope\.mjs --base "\$BASE_SHA" --head "\$HEAD_SHA"/);
  assert.match(scope, /fetch-depth: 0/);
  const job2 = (name) =>
    suite.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm'))?.[0] ?? '';
  for (const name of ['build', 'coverage-gate', 'test-integration']) {
    assert.match(
      job2(name),
      /^    if: inputs\.mode == 'full' \|\| github\.event_name == 'merge_group'$/m,
      `${name} must run in every merge group`,
    );
  }
  // Every Turbo selection reads the merge-group base, not only the PR base.
  const bases = suite.match(/BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \|\| github\.event\.pull_request\.base\.sha \}\}/g);
  assert.equal(bases?.length, 3);
  // PostgreSQL: scope failure or empty selection of a non-empty plan cannot pass silently.
  assert.match(postgres, /node scripts\/merge-group-scope\.mjs/);
  assert.match(postgres, /merge-group PostgreSQL scope produced no selection/);
  assert.match(postgres, /POSTGRES_AFFECTED: \$\{\{ needs\.scope\.outputs\.affected \}\}/);
});

test('affected knowledge freshness keeps the release upgrade gate (#5364)', () => {
  const suite = readFileSync(new URL('../.github/workflows/test-suite.yml', import.meta.url), 'utf8');
  const affected = suite.match(/^  affected-knowledge:\n[\s\S]*?(?=^  [a-z][a-z0-9-]*:\n)/m)?.[0] ?? '';
  assert.match(affected, /run: pnpm check:release-upgrade$/m);
});

test('affected package shards and the scope job carry no ordering-only needs, and a failed scope job still fails Required CI (#5646)', () => {
  const suite = readFileSync(
    new URL('../.github/workflows/test-suite.yml', import.meta.url),
    'utf8',
  );
  const suiteJob = (name) => {
    const block = suite.match(
      new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm'),
    )?.[0];
    assert.ok(block, `test-suite job ${name} must exist`);
    return block;
  };
  const needsOf = (block) => {
    const inline = block.match(/^    needs: (.+)$/m)?.[1];
    if (inline) return inline.replace(/[[\]\s]/g, '').split(',');
    const list = block.match(/^    needs:\n((?:      - .+\n)+)/m)?.[1];
    return list ? [...list.matchAll(/- (.+)/g)].map((m) => m[1]) : [];
  };

  // The shards recompute their own Turbo dry run; waiting added ~80 s.
  assert.deepEqual(needsOf(suiteJob('affected-package-tests')), []);
  assert.deepEqual(needsOf(suiteJob('affected-test-scope')), []);
  assert.match(
    suiteJob('affected-package-tests'),
    /^    if: inputs\.mode == 'affected'$/m,
  );
  assert.doesNotMatch(
    suiteJob('affected-package-tests'),
    /needs\.affected-test-scope/,
  );
  // The core shards still consume the scope job's output.
  assert.deepEqual(needsOf(suiteJob('affected-core-tests')), [
    'affected-test-scope',
  ]);
  assert.match(
    suiteJob('affected-core-tests'),
    /^    if: inputs\.mode == 'affected' && needs\.affected-test-scope\.outputs\.core == 'true'$/m,
  );
  // The scope job and package shards still run the same Turbo selection.
  assert.match(suiteJob('affected-test-scope'), /affected-test-shard\.mjs --has-core/);
  assert.match(suiteJob('affected-package-tests'), /affected-test-shard\.mjs '\$\{\{ matrix\.shard \}\}'/);

  // Required CI still aggregates the same `test` result, and it must fail for
  // any non-success result: a failed scope job fails the reusable workflow.
  const required = job('required-ci');
  assert.match(required, /^      - test$/m);
  assert.match(required, /TEST_SUITE: \$\{\{ needs\.test\.result \}\}/);
  const script = required
    .match(/^        run: \|\n([\s\S]*)/m)?.[1]
    ?.replace(/^          /gm, '');
  assert.ok(script);
  const env = {};
  for (const m of required.matchAll(
    /^          ([A-Z_]+): \$\{\{ needs\.[^\n]+\.result \}\}$/gm,
  )) {
    env[m[1]] = 'success';
  }
  Object.assign(env, {
    EVENT_NAME: 'pull_request',
    PUBLISH_DRY_RUN: 'skipped',
    VISUAL_SELECTED: 'false',
    VISUAL_RESULT: 'skipped',
    PLANNER_SELECTED: 'false',
    PLANNER_RESULT: 'skipped',
    DOCS_SELECTED: 'false',
    DOCS_RESULT: 'skipped',
  });
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const run = spawnSync('bash', ['-c', script], {
      env: { ...env, TEST_SUITE: result },
      encoding: 'utf8',
    });
    assert.equal(
      run.status === 0,
      result === 'success',
      `test suite ${result || 'absent'}: ${run.stdout}${run.stderr}`,
    );
  }
});
