import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  evaluateBrowserCases,
  evaluateGate,
  evaluateVitestCases,
  listTemplateTestFiles,
  NEEDS_GROUPS,
  OWNING_PACKAGE_FILES,
  PARTS,
  POSTGRES_FILES,
  REQUIRED_BROWSER_CASES,
  REQUIRED_VITEST_CASES,
  SCHEMA_VERSION,
  SPLIT_FILE_MINIMUMS,
  TEMPLATE_SHARD_FILES,
  templateShardFiles,
  vocabularyViolations,
} from '../packages/template-sveltekit/e2e/support/gateSpec.mjs';

const packageRoot = fileURLToPath(
  new URL('../packages/template-sveltekit/', import.meta.url),
);
const gate = join(packageRoot, 'e2e/support/gate.mjs');

/** The real include-glob selection of this checkout. */
const expectedFiles = listTemplateTestFiles(packageRoot);

const needs = () => Object.fromEntries(NEEDS_GROUPS.map((g) => [g, 'success']));

/**
 * A fully passing set of part results, built from the spec: each required case
 * is observed once, in the part and suite that owns it, and every test file is
 * reported by exactly one part with the floors it must meet.
 */
function healthyParts() {
  const parts = PARTS.map((definition) => ({
    schemaVersion: SCHEMA_VERSION,
    gate: 'm5',
    part: definition.id,
    exits: definition.kind === 'browser' ? { playwright: 0 } : { vitest: 0 },
    cases: [],
    files: [],
  }));
  const part = (id) => parts.find((entry) => entry.part === id);
  const postgres = part('postgres');

  const nonPostgres = expectedFiles.filter((f) => !f.endsWith(POSTGRES_FILES));
  for (const id of ['template-1', 'template-2', 'template-3']) {
    for (const file of templateShardFiles(id, expectedFiles)) {
      part(id).files.push({
        file,
        suite: 'template',
        tests: 3,
        passed: Math.max(3, SPLIT_FILE_MINIMUMS[file] ?? 0),
        failed: 0,
      });
    }
  }
  for (const file of expectedFiles.filter((f) => f.endsWith(POSTGRES_FILES))) {
    postgres.files.push({ file, suite: 'template', tests: 1, passed: 1, failed: 0 });
  }
  for (const [suite, file] of Object.entries(OWNING_PACKAGE_FILES)) {
    postgres.files.push({ file, suite, tests: 1, passed: 1, failed: 0 });
  }
  postgres.cases.push({ id: 'postgres-service', passed: true });

  // Required vitest cases: observed in the part that owns their suite. A
  // template case is observed in template-1; the postgres-profile ones in the
  // postgres part, as in CI.
  for (const required of REQUIRED_VITEST_CASES) {
    const suite = required.suite ?? 'template';
    const owner = suite === 'template' ? part('template-1') : postgres;
    owner.cases.push({
      id: required.id,
      profile: required.profile,
      suite,
      passed: true,
      observed: 1,
    });
  }
  part('browser').cases.push(
    ...REQUIRED_BROWSER_CASES.map((c) => ({
      id: c.id,
      profile: 'sqlite',
      passed: true,
      observed: 1,
    })),
  );
  assert.equal(nonPostgres.length > 0, true);
  return parts;
}

const run = (overrides = {}) =>
  evaluateGate({
    parts: healthyParts(),
    needs: needs(),
    expectedFiles,
    expectedPartCount: PARTS.length,
    ...overrides,
  });

const messages = (verdict) => verdict.failures.join('\n');

test('a complete, healthy set of parts passes', () => {
  const verdict = run();
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.passed, true);
  assert.equal(verdict.summary.passed, true);
  assert.deepEqual(vocabularyViolations(verdict.summary), []);
});

test('the shard definitions cover the include glob, each file once', () => {
  const claimed = Object.values(TEMPLATE_SHARD_FILES).flat();
  for (const file of claimed) assert.ok(expectedFiles.includes(file), file);
  const union = [
    ...['template-1', 'template-2', 'template-3'].flatMap((id) =>
      templateShardFiles(id, expectedFiles),
    ),
    ...expectedFiles.filter((f) => f.endsWith(POSTGRES_FILES)),
  ].sort();
  assert.deepEqual(union, [...expectedFiles].sort());
  assert.equal(new Set(union).size, union.length);
  for (const file of Object.keys(SPLIT_FILE_MINIMUMS))
    assert.ok(expectedFiles.includes(file), `${file} is a real test file`);
});

test('a missing part fails', () => {
  const parts = healthyParts().filter((p) => p.part !== 'template-2');
  const verdict = run({ parts });
  assert.equal(verdict.passed, false);
  assert.match(messages(verdict), /part template-2 is missing/);
});

test('a duplicated part fails', () => {
  const parts = healthyParts();
  parts.push(structuredClone(parts.find((p) => p.part === 'template-1')));
  const verdict = run({ parts });
  assert.equal(verdict.passed, false);
  assert.match(messages(verdict), /part template-1 reported more than once/);
  assert.match(messages(verdict), /expected 5 part results, found 6/);
});

test('an empty part result fails', () => {
  const parts = healthyParts();
  const target = parts.find((p) => p.part === 'template-3');
  target.cases = [];
  target.files = [];
  const verdict = run({ parts });
  assert.equal(verdict.passed, false);
  assert.match(messages(verdict), /part template-3 reported nothing/);
  assert.match(messages(verdict), /part template-3 ran no test files/);
});

test('an unknown part, an unknown shape and a stale schema fail', () => {
  for (const mutate of [
    (p) => ({ ...p, part: 'template-9' }),
    (p) => ({ ...p, schemaVersion: SCHEMA_VERSION - 1 }),
    (p) => ({ ...p, gate: 'other' }),
  ]) {
    const parts = healthyParts();
    parts[0] = mutate(parts[0]);
    assert.equal(run({ parts }).passed, false);
  }
  const unknown = healthyParts();
  unknown[0] = { ...unknown[0], part: 'template-9' };
  assert.match(messages(run({ parts: unknown })), /part template-1 is missing/);
  assert.equal(run({ parts: [...healthyParts(), null] }).passed, false);
});

test('a zero-file shard fails even when every required case passes elsewhere', () => {
  const parts = healthyParts();
  parts.find((p) => p.part === 'template-2').files = [];
  const verdict = run({ parts });
  assert.equal(verdict.passed, false);
  assert.match(messages(verdict), /part template-2 ran no test files/);
  // Its files are then absent from every part.
  assert.match(messages(verdict), /cookbookHost\.part3\.test\.ts ran in no part/);
});

test('a non-zero shard exit fails even when every required case passes', () => {
  const parts = healthyParts();
  parts.find((p) => p.part === 'template-3').exits = { vitest: 1 };
  const verdict = run({ parts });
  assert.equal(verdict.passed, false);
  assert.match(messages(verdict), /part template-3: the vitest run exited 1/);
  assert.ok(
    verdict.summary.cases.every(
      (c) => !REQUIRED_VITEST_CASES.some((r) => r.id === c.id) || c.passed,
    ),
    'every required case itself still passed',
  );
  assert.equal(
    verdict.summary.cases.find((c) => c.id === 'template-3-exit').passed,
    false,
  );
});

test('a part with no recorded exit status fails', () => {
  const parts = healthyParts();
  parts.find((p) => p.part === 'browser').exits = {};
  assert.match(messages(run({ parts })), /part browser carries no exit status/);
});

test('a required case reported only by the wrong suite does not count', () => {
  const parts = healthyParts();
  // `asset-manifest-portability` belongs to the cli suite. A same-named hit in
  // the template suite must not satisfy it.
  const postgres = parts.find((p) => p.part === 'postgres');
  for (const entry of postgres.cases) {
    if (entry.id === 'asset-manifest-portability') entry.suite = 'template';
  }
  const verdict = run({ parts });
  assert.equal(verdict.passed, false);
  assert.match(
    messages(verdict),
    /required case asset-manifest-portability did not run/,
  );
});

test('a required case that ran and failed in any part fails', () => {
  const parts = healthyParts();
  parts.find((p) => p.part === 'template-3').cases.push({
    id: 'embedded-job-parity',
    profile: 'sqlite',
    suite: 'template',
    passed: false,
    observed: 1,
  });
  assert.match(
    messages(run({ parts })),
    /required case embedded-job-parity did not pass/,
  );
});

test('a required case found in no part fails as not run', () => {
  const parts = healthyParts();
  for (const part of parts) {
    part.cases = part.cases.filter((c) => c.id !== 'embedded-job-parity');
  }
  assert.match(
    messages(run({ parts })),
    /required case embedded-job-parity did not run/,
  );
});

test('the per-file floor catches a split file that lost its tests', () => {
  const parts = healthyParts();
  const file = parts
    .flatMap((p) => p.files)
    .find((f) => f.file === '__tests__/cookbookApply.welder.test.ts');
  file.tests = 0;
  file.passed = 0;
  const verdict = run({ parts });
  assert.equal(verdict.passed, false);
  assert.match(
    messages(verdict),
    /cookbookApply\.welder\.test\.ts ran no passing tests/,
  );
  assert.match(messages(verdict), /cookbookApply\.welder\.test\.ts ran 0 passing/);
});

test('a test file in no part, in two parts, or outside the glob fails', () => {
  const dropped = healthyParts();
  const t3 = dropped.find((p) => p.part === 'template-3');
  const gone = t3.files.pop();
  assert.match(
    messages(run({ parts: dropped })),
    new RegExp(`${gone.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ran in no part`),
  );

  const doubled = healthyParts();
  doubled
    .find((p) => p.part === 'template-2')
    .files.push(structuredClone(doubled.find((p) => p.part === 'template-1').files[0]));
  assert.match(messages(run({ parts: doubled })), /ran in more than one part/);

  const extra = healthyParts();
  extra
    .find((p) => p.part === 'template-3')
    .files.push({
      file: '__tests__/neverSelected.test.ts',
      suite: 'template',
      tests: 1,
      passed: 1,
      failed: 0,
    });
  assert.match(
    messages(run({ parts: extra })),
    /neverSelected\.test\.ts ran but is not a selected test file/,
  );
});

test('a PostgreSQL file outside the postgres part fails', () => {
  const parts = healthyParts();
  const postgres = parts.find((p) => p.part === 'postgres');
  const index = postgres.files.findIndex((f) => f.file.endsWith(POSTGRES_FILES));
  const [moved] = postgres.files.splice(index, 1);
  parts.find((p) => p.part === 'template-3').files.push(moved);
  const verdict = run({ parts });
  assert.equal(verdict.passed, false);
  assert.match(messages(verdict), /must run in the postgres part/);
});

test('postgres-service must come from exactly one part, postgres', () => {
  const twice = healthyParts();
  twice
    .find((p) => p.part === 'template-1')
    .cases.push({ id: 'postgres-service', passed: true });
  assert.match(messages(run({ parts: twice })), /postgres-service/);

  const none = healthyParts();
  const postgres = none.find((p) => p.part === 'postgres');
  postgres.cases = postgres.cases.filter((c) => c.id !== 'postgres-service');
  assert.match(messages(run({ parts: none })), /postgres-service/);

  const failing = healthyParts();
  failing
    .find((p) => p.part === 'postgres')
    .cases.find((c) => c.id === 'postgres-service').passed = false;
  assert.equal(run({ parts: failing }).passed, false);

  const elsewhere = healthyParts();
  const entry = elsewhere
    .find((p) => p.part === 'postgres')
    .cases.splice(0, 1)[0];
  elsewhere.find((p) => p.part === 'template-1').cases.push(entry);
  assert.match(messages(run({ parts: elsewhere })), /exactly one part, postgres/);
});

test('--skip-browser marks the browser cases skipped and fails the verdict', () => {
  const parts = healthyParts();
  const browser = parts.find((p) => p.part === 'browser');
  browser.cases = REQUIRED_BROWSER_CASES.map((c) => ({
    id: c.id,
    passed: false,
    skipped: true,
  }));
  browser.exits = { playwright: 1 };
  const verdict = run({ parts });
  assert.equal(verdict.passed, false);
  assert.match(messages(verdict), /browser cases were skipped explicitly/);
  assert.ok(
    verdict.summary.cases
      .filter((c) => c.id.startsWith('browser-') && c.id !== 'browser-exit')
      .every((c) => c.passed === false && c.skipped === true),
  );
});

test('a skipped, failed, cancelled or absent job group fails regardless of parts', () => {
  for (const group of NEEDS_GROUPS) {
    for (const result of ['skipped', 'failure', 'cancelled', '', undefined]) {
      const verdict = run({ needs: { ...needs(), [group]: result } });
      assert.equal(verdict.passed, false, `${group}=${String(result)}`);
      assert.match(messages(verdict), new RegExp(`the ${group} job group`));
    }
  }
  assert.equal(run({ needs: {} }).passed, false);
});

test('the workflow matrix size must equal the gate definition', () => {
  const verdict = run({ expectedPartCount: PARTS.length - 1 });
  assert.equal(verdict.passed, false);
  assert.match(messages(verdict), /workflow expects 4 parts/);
});

test('problems loading part results fail the verdict', () => {
  const verdict = run({ loadProblems: ['a part result file is empty'] });
  assert.equal(verdict.passed, false);
  assert.match(messages(verdict), /a part result file is empty/);
});

test('content outside the sanitized vocabulary is rejected, not echoed', () => {
  const parts = healthyParts();
  parts[0].files[0].file = '/Users/someone/secret/path.test.ts';
  const verdict = run({ parts });
  assert.equal(verdict.passed, false);
  assert.match(messages(verdict), /outside the sanitized vocabulary/);
  assert.doesNotMatch(messages(verdict), /someone/);

  assert.ok(vocabularyViolations({ message: 'x' }).length > 0);
  assert.ok(vocabularyViolations({ id: 'not-a-known-id' }).length > 0);
  assert.deepEqual(
    vocabularyViolations({ id: 'embedded-job-parity', passed: true, observed: 2 }),
    [],
  );
});

test('case evaluation is per suite and names a failing match', () => {
  const entries = [
    {
      suite: 'template',
      name: 'x seeds ordinary owner, tenant, asset, and queued-workflow state on file-backed SQLite',
      status: 'passed',
    },
    {
      suite: 'template',
      name: 'completes the same enqueued workflow under local embedded execution',
      status: 'failed',
    },
  ];
  const cases = evaluateVitestCases(entries, ['template']);
  assert.equal(cases.every((c) => c.suite === 'template'), true);
  assert.equal(cases.find((c) => c.id === 'sqlite-file-backed-workload').observed, 1);
  assert.equal(cases.find((c) => c.id === 'embedded-job-parity').passed, false);
  assert.equal(cases.find((c) => c.id === 'cross-profile-agent-surface').observed, 0);
  assert.equal(
    evaluateVitestCases(entries, ['cli']).some((c) => c.suite === 'template'),
    false,
  );
  const browser = evaluateBrowserCases([
    { name: 'completes owner onboarding without exposing the bootstrap token', status: 'skipped' },
  ]);
  assert.equal(browser[0].passed, false);
  assert.equal(browser[0].observed, 1);
});

test('the verdict CLI runs from a bare checkout and reads one folder per artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'm5-verdict-'));
  const write = (parts) => {
    for (const part of parts) {
      const folder = join(root, `m5-part-${part.part}`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `m5-part-${part.part}.json`), JSON.stringify(part));
    }
  };
  write(healthyParts());
  const args = [
    gate,
    'verdict',
    '--parts-dir',
    root,
    '--expected-parts',
    String(PARTS.length),
    '--template',
    'success',
    '--postgres',
    'success',
    '--browser',
    'success',
    '--out',
    join(root, 'summary.json'),
  ];
  const ok = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).passed, true);

  const skipped = spawnSync(
    process.execPath,
    args.map((arg, i) => (args[i - 1] === '--browser' ? 'skipped' : arg)),
    { encoding: 'utf8' },
  );
  assert.equal(skipped.status, 1);
  assert.match(skipped.stderr, /the browser job group ended "skipped"/);

  const empty = mkdtempSync(join(tmpdir(), 'm5-verdict-empty-'));
  const none = spawnSync(
    process.execPath,
    args.map((arg) => (arg === root ? empty : arg)),
    { encoding: 'utf8' },
  );
  assert.equal(none.status, 1);
  assert.match(none.stderr, /part template-1 is missing/);

  assert.equal(JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8')).passed, false);
});
