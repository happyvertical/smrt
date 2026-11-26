import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('Coverage Gate reuses the core shard coverage and a skipped core job cannot skip it (#5648)', () => {
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
  const needsOf = (block) =>
    (block.match(/^    needs: (.+)$/m)?.[1] ?? '')
      .replace(/[[\]\s]/g, '')
      .split(',')
      .filter(Boolean);
  const shardsOf = (block) =>
    block.match(/^        shard: \[(.+)\]$/m)?.[1].split(',').length;

  const nonCore = suiteJob('coverage-gate');
  const gate = suiteJob('coverage-gate-core');
  const full = suiteJob('test-core');
  const affected = suiteJob('affected-core-tests');

  // Non-core gate: starts as soon as build finishes and never re-runs core.
  assert.deepEqual(needsOf(nonCore), ['build']);
  assert.match(nonCore, /run: node scripts\/check-coverage\.mjs --exclude core$/m);
  assert.match(nonCore, /^    if: inputs\.mode == 'full' \|\| github\.event_name == 'merge_group'$/m);

  // Core gate: a skipped test-core / affected-core-tests must never skip it.
  assert.deepEqual(needsOf(gate), ['build', 'test-core', 'affected-core-tests']);
  const admission = gate.match(/^    if: >-\n([\s\S]*?)(?=^    \S)/m)?.[1] ?? '';
  const flat = admission.replace(/\s+/g, ' ').trim();
  assert.equal(
    flat,
    "!cancelled() && (inputs.mode == 'full' || github.event_name == 'merge_group') && needs.build.result == 'success'",
  );
  assert.doesNotMatch(admission, /success\(\)|always\(\)/);
  assert.doesNotMatch(admission, /needs\.(test-core|affected-core-tests)/);
  assert.doesNotMatch(suite, /continue-on-error/);

  // Shard results are checked explicitly, and everything after the scope
  // probe is conditional on it so an untouched core ends the job early.
  assert.match(gate, /core-coverage-merge\.mjs shard-results/);
  assert.match(gate, /--test-core "\$\{\{ needs\.test-core\.result \}\}"/);
  assert.match(gate, /--affected-core-tests "\$\{\{ needs\.affected-core-tests\.result \}\}"/);
  assert.match(gate, /node scripts\/check-coverage\.mjs --only core --list-checked/);
  assert.match(gate, /fetch-depth: 0/);
  const afterScope = gate.slice(gate.indexOf('id: scope'));
  const steps = afterScope.split(/^      - name: /m).slice(1);
  assert.ok(steps.length >= 7);
  for (const step of steps) {
    assert.match(step, /^ {8}if: steps\.scope\.outputs\.core == 'true'$/m, step.split('\n')[0]);
  }
  // Same build, manifest and absolute checkout root as the shards.
  assert.match(gate, /--filter='@happyvertical\/smrt-core\.\.\.'/);
  assert.match(gate, /generate:test --filter='@happyvertical\/smrt-core'/);
  // One folder per artifact so a duplicate blob is seen, not overwritten.
  assert.match(gate, /pattern: core-coverage-blob-\*/);
  assert.doesNotMatch(gate, /merge-multiple:/);
  assert.match(gate, /core-coverage-merge\.mjs merge\s+--blobs/);
  assert.match(gate, /--expected-shards "\$CORE_SHARDS"/);
  assert.match(
    gate,
    /node scripts\/check-coverage\.mjs --only core\s+--summary core=packages\/core\/coverage\/coverage-summary\.json/,
  );

  // The expected shard count is the matrix size of BOTH producers.
  const expected = Number(gate.match(/CORE_SHARDS: '(\d+)'/)?.[1]);
  assert.equal(shardsOf(full), expected);
  assert.equal(shardsOf(affected), expected);

  // Both producers emit distinct blobs with the blob reporter, upload them,
  // and fail the shard if no blob was written.
  for (const producer of [full, affected]) {
    assert.match(producer, /--coverage \\\n\s+--reporter=default --reporter=blob/);
    assert.match(
      producer,
      /--outputFile\.blob="\.vitest-reports\/blob-\$\{SHARD%\/\*\}-\$\{SHARD#\*\/\}\.json"/,
    );
    assert.match(producer, /path: packages\/core\/\.vitest-reports\/blob-\*\.json/);
    assert.match(producer, /if-no-files-found: error/);
  }
  assert.match(full, /name: core-coverage-blob-full-\$\{\{ strategy\.job-index \}\}/);
  assert.match(affected, /name: core-coverage-blob-affected-\$\{\{ strategy\.job-index \}\}/);
  // Affected mode pays for coverage only in a merge group, where the gate runs.
  assert.match(
    affected,
    /- name: Run affected core tests \(shard[^\n]+\n\s+if: github\.event_name != 'merge_group'/,
  );
  assert.match(
    affected,
    /- name: Run affected core tests with coverage blob[^\n]+\n\s+if: github\.event_name == 'merge_group'/,
  );
  assert.match(affected, /if: always\(\) && github\.event_name == 'merge_group'/);

  // The caller's required result is the reusable workflow's result, which
  // fails when either gate job fails; fork-pr-validation reaches the same
  // jobs in full mode.
  assert.match(job('required-ci'), /TEST_SUITE: \$\{\{ needs\.test\.result \}\}/);
  const fork = readFileSync(
    new URL('../.github/workflows/fork-pr-validation.yml', import.meta.url),
    'utf8',
  );
  assert.match(fork, /uses: \.\/\.github\/workflows\/test-suite\.yml\n\s+with:\n\s+mode: full/);
});

test('in a merge group the core shards run whenever the coverage gate deems core touched (#5648)', () => {
  const suite = readFileSync(
    new URL('../.github/workflows/test-suite.yml', import.meta.url),
    'utf8',
  );
  const block = (name) =>
    suite.match(
      new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm'),
    )?.[0];
  const scope = block('affected-test-scope');
  const gate = block('coverage-gate-core');
  const cmd = 'node scripts/check-coverage.mjs --only core --list-checked';
  // Same probe command and same BASE_REF expression on both sides.
  assert.ok(scope.includes(cmd) && gate.includes(cmd));
  const baseRef = 'BASE_REF: ${{ github.base_ref }}';
  assert.ok(scope.includes(baseRef) && gate.includes(baseRef));

  // Execute the scope step with stubbed tools. Turbo's selection says "no
  // core"; the gate probe says core is touched (earlier queue entry).
  const script = scope
    .match(/^        run: \|\n((?: {10}.*\n|\n)+)/m)?.[1]
    ?.replace(/^ {10}/gm, '');
  assert.ok(script);
  const run = (event, gateSays, turboSays = 'false') => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
    writeFileSync(
      join(bin, 'node'),
      `#!/bin/sh\ncase "$*" in\n*affected-test-shard*) cat >/dev/null; echo ${turboSays};;\n*check-coverage*) echo ${gateSays};;\nesac\n`,
      { mode: 0o755 },
    );
    const out = join(dir, 'out');
    writeFileSync(out, '');
    const r = spawnSync('bash', ['-c', script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        BASE_SHA: 'abc',
        GITHUB_EVENT_NAME: event,
        GITHUB_OUTPUT: out,
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(out, 'utf8').trim();
  };
  assert.equal(run('merge_group', 'core'), 'core=true'); // the failing case
  assert.equal(run('merge_group', ''), 'core=false');
  assert.equal(run('pull_request', 'core'), 'core=false'); // PRs: no gate
  assert.equal(run('merge_group', '', 'true'), 'core=true');
});

test('turbo xargs lines and hidden-directory uploads cannot silently break (#5658)', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  for (const file of ['test-suite.yml', 'postgres-tests.yml']) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    // `--summarize` takes an optional value, so a bare flag directly before the
    // piped unit ids swallows the first id ("invalid value ... for --summarize").
    for (const line of text.split('\n')) {
      if (/xargs .*turbo run/.test(line)) {
        assert.doesNotMatch(line, /--summarize(\s|$)/, `${file}: ${line.trim()}`);
      }
    }
  }
  const suite = readFileSync(new URL('test-suite.yml', dir), 'utf8');
  const uploads = suite.split(/^ {6}- name: /m).filter((step) =>
    /upload-artifact@/.test(step) && /path:.*\/\./.test(step),
  );
  assert.ok(uploads.length >= 2, 'core coverage blob uploads present');
  for (const step of uploads) {
    // upload-artifact excludes hidden files/directories by default.
    assert.match(step, /include-hidden-files: true/, step.split('\n')[0]);
  }
});

test('the M5 gate runs as parallel parts and one aggregator that a skipped part cannot skip (#5694)', async () => {
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
  const flatIf = (block) =>
    (block.match(/^    if: >-\n([\s\S]*?)(?=^    \S)/m)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const { PARTS, NEEDS_GROUPS } = await import(
    '../packages/template-sveltekit/e2e/support/gateSpec.mjs'
  );

  const template = suiteJob('m5-template');
  const postgres = suiteJob('m5-postgres');
  const browser = suiteJob('m5-browser');
  const aggregate = suiteJob('m5-reference-gate');

  // The aggregator keeps its old id and name, and needs every part job.
  assert.match(aggregate, /^    name: M5 Reference Fixture Gate$/m);
  assert.match(aggregate, /^    needs: \[m5-template, m5-postgres, m5-browser\]$/m);

  // It can never evaluate false in either mode (Required CI reads only
  // `needs.test.result`): `!cancelled()` and nothing else, with no `always()`
  // and no `continue-on-error` anywhere in the workflow.
  assert.match(aggregate, /^    if: \$\{\{ !cancelled\(\) \}\}$/m);
  assert.doesNotMatch(aggregate.split('\n    steps:')[0], /always\(\)|success\(\)/);
  assert.doesNotMatch(suite, /continue-on-error/);
  for (const part of [template, postgres, browser]) {
    // `build` is skipped in affected mode, so a bare `needs` would skip them.
    assert.equal(
      flatIf(part),
      "!cancelled() && (inputs.mode == 'affected' || needs.build.result == 'success')",
    );
    assert.match(part, /^    needs: build$/m);
  }

  // Each part's result is passed to the verdict explicitly, never inferred.
  assert.match(aggregate, /M5_TEMPLATE: \$\{\{ needs\.m5-template\.result \}\}/);
  assert.match(aggregate, /M5_POSTGRES: \$\{\{ needs\.m5-postgres\.result \}\}/);
  assert.match(aggregate, /M5_BROWSER: \$\{\{ needs\.m5-browser\.result \}\}/);
  assert.match(aggregate, /gate\.mjs verdict/);
  assert.match(aggregate, /--template "\$M5_TEMPLATE"/);
  assert.match(aggregate, /--postgres "\$M5_POSTGRES"/);
  assert.match(aggregate, /--browser "\$M5_BROWSER"/);
  assert.deepEqual([...NEEDS_GROUPS].sort(), ['browser', 'postgres', 'template']);

  // One folder per artifact (no merge-multiple), hidden-file free, and a part
  // that wrote no result fails its own upload.
  assert.match(aggregate, /pattern: m5-part-\*/);
  assert.doesNotMatch(aggregate, /merge-multiple:/);
  for (const part of [template, postgres, browser]) {
    assert.match(part, /if-no-files-found: error/);
    assert.doesNotMatch(part, /include-hidden-files/);
    assert.match(part, /path: packages\/template-sveltekit\/m5-part-/);
  }
  assert.match(template, /name: m5-part-template-\$\{\{ strategy\.job-index \}\}/);
  assert.match(postgres, /name: m5-part-postgres$/m);
  assert.match(browser, /name: m5-part-browser$/m);

  // The expected part count is the matrix size plus the two single jobs, and
  // equals what the gate defines.
  const matrix = template.match(/^        part: \[(.+)\]$/m)?.[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  const expected = Number(aggregate.match(/M5_EXPECTED_PARTS: '(\d+)'/)?.[1]);
  assert.equal(expected, matrix.length + 2);
  assert.equal(expected, PARTS.length);
  assert.deepEqual(
    PARTS.filter((p) => p.needs === 'template').map((p) => p.id),
    matrix,
  );
  assert.match(aggregate, /--expected-parts "\$M5_EXPECTED_PARTS"/);

  // The aggregator needs a checkout and node, nothing installed; the parts
  // that need no PostgreSQL or browser do not pay for either.
  assert.doesNotMatch(aggregate, /setup-environment|pnpm /);
  assert.doesNotMatch(aggregate, /services:/);
  assert.match(postgres, /^    services:\n      postgres:/m);
  assert.doesNotMatch(template, /services:|setup-playwright: 'true'/);
  assert.doesNotMatch(browser, /services:/);
  assert.match(browser, /setup-playwright: 'true'/);
  assert.match(postgres, /test:m5:part:postgres/);
  assert.match(postgres, /CI_POSTGRES_BASE_URL: /);
  assert.doesNotMatch(template, /CI_POSTGRES_BASE_URL/);

  // Exactly one job emits `postgres-service`: the one with the service.
  assert.equal((suite.match(/^    services:$/gm) ?? []).length >= 1, true);
  const jobsWithM5Services = ['m5-template', 'm5-postgres', 'm5-browser', 'm5-reference-gate']
    .filter((name) => /^    services:$/m.test(suiteJob(name)));
  assert.deepEqual(jobsWithM5Services, ['m5-postgres']);

  // fork-pr-validation reaches these jobs through `mode: full`.
  const fork = readFileSync(
    new URL('../.github/workflows/fork-pr-validation.yml', import.meta.url),
    'utf8',
  );
  assert.match(fork, /uses: \.\/\.github\/workflows\/test-suite\.yml\n\s+with:\n\s+mode: full/);
});
