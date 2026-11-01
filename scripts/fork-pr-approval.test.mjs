import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  APPROVAL_LABEL,
  approvalProblems,
  gateProblems,
  REQUIRED_CONTEXTS,
  selectRequiredJobs,
} from './fork-pr-approval.mjs';

const HEAD = 'a'.repeat(40);

function input(overrides = {}) {
  return {
    expectedHeadSha: HEAD,
    pr: {
      state: 'open',
      head: { sha: HEAD },
      labels: [{ name: APPROVAL_LABEL }],
    },
    files: [{ filename: 'packages/core/src/index.ts' }],
    validationRuns: [
      {
        head_sha: HEAD,
        event: 'pull_request',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-10-31T10:00:00Z',
      },
    ],
    ...overrides,
  };
}

function workflow(name) {
  return readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
}

function job(source, name) {
  const match = source.match(
    new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm'),
  );
  assert.ok(match, `workflow job ${name} must exist`);
  return match[0];
}

test('an approved, sandbox-green head with no .github change passes', () => {
  assert.deepEqual(approvalProblems(input()), []);
  assert.deepEqual(gateProblems({ runAttempt: 2, ...input() }), []);
});

test('the first run attempt never passes, whatever the approval state', () => {
  const problems = gateProblems({ runAttempt: 1, ...input() });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /maintainer/);
  assert.equal(gateProblems({ runAttempt: Number.NaN, ...input() }).length, 1);
});

test('a missing label, moved head or closed PR is refused', () => {
  assert.equal(approvalProblems(input({ pr: { ...input().pr, labels: [] } })).length, 1);
  assert.match(
    approvalProblems(input({ pr: { ...input().pr, head: { sha: 'b'.repeat(40) } } }))[0],
    /head moved/,
  );
  assert.match(approvalProblems(input({ pr: { ...input().pr, state: 'closed' } }))[0], /closed/);
});

test('any change under .github/, including a rename out of it, is refused', () => {
  for (const file of [
    { filename: '.github/workflows/fork-pr-validation.yml' },
    { filename: '.github/actions/setup-environment/action.yml' },
    { filename: 'moved.yml', previous_filename: '.github/workflows/test-suite.yml' },
  ]) {
    const problems = approvalProblems(input({ files: [file] }));
    assert.equal(problems.length, 1, JSON.stringify(file));
    assert.match(problems[0], /\.github\//);
  }
  assert.deepEqual(approvalProblems(input({ files: [{ filename: 'docs/github.md' }] })), []);
});

test('the latest sandbox run for the exact head must have succeeded', () => {
  const run = input().validationRuns[0];
  for (const runs of [
    [],
    [{ ...run, head_sha: 'b'.repeat(40) }],
    [{ ...run, event: 'pull_request_target' }],
    [{ ...run, status: 'in_progress', conclusion: null }],
    [{ ...run, conclusion: 'failure' }],
    [
      { ...run, created_at: '2026-10-31T09:00:00Z' },
      { ...run, conclusion: 'cancelled', created_at: '2026-10-31T11:00:00Z' },
    ],
  ]) {
    assert.equal(approvalProblems(input({ validationRuns: runs })).length, 1, JSON.stringify(runs));
  }
  assert.deepEqual(
    approvalProblems(
      input({
        validationRuns: [
          { ...run, conclusion: 'failure', created_at: '2026-10-31T09:00:00Z' },
          run,
        ],
      }),
    ),
    [],
  );
});

test('approve re-runs the latest GitHub Actions job behind each required context', () => {
  const runs = REQUIRED_CONTEXTS.flatMap((name, index) => [
    { id: 10 + index, name, app: { slug: 'github-actions' }, status: 'completed', started_at: '2026-10-31T09:00:00Z' },
    { id: 20 + index, name, app: { slug: 'github-actions' }, status: 'completed', started_at: '2026-10-31T10:00:00Z' },
    { id: 30 + index, name, app: { slug: 'another-app' }, status: 'completed', started_at: '2026-10-31T11:00:00Z' },
  ]);
  assert.deepEqual(selectRequiredJobs(runs), {
    jobs: REQUIRED_CONTEXTS.map((context, index) => ({ context, id: 20 + index })),
    problems: [],
  });
  const pending = selectRequiredJobs([
    { id: 1, name: REQUIRED_CONTEXTS[0], app: { slug: 'github-actions' }, status: 'in_progress', started_at: '2026-10-31T09:00:00Z' },
  ]);
  assert.equal(pending.jobs.length, 0);
  assert.equal(pending.problems.length, REQUIRED_CONTEXTS.length);
});

test('Fork PR Validation is sandboxed: pull_request only, forks only, read-only, no secrets', () => {
  const source = workflow('fork-pr-validation.yml');
  const on = source.slice(source.indexOf('\non:'), source.indexOf('\nconcurrency:'));
  assert.match(on, /^  pull_request:$/m);
  assert.doesNotMatch(on, /pull_request_target|merge_group|workflow_run/);
  assert.doesNotMatch(source, /: write\b/);
  assert.doesNotMatch(source, /secrets\./);
  for (const name of ['commits', 'test', 'postgres']) {
    assert.match(
      job(source, name),
      /^    if: github\.event\.pull_request\.head\.repo\.full_name != github\.repository$/m,
    );
  }
  assert.doesNotMatch(source, /name: (Required CI|postgres-required)$/m);
});

test('Fork PR Approval never checks out or runs PR code', () => {
  const source = workflow('fork-pr-approval.yml');
  assert.match(source, /^  pull_request_target:$/m);
  assert.match(source, /^permissions: \{\}$/m);
  const approve = job(source, 'approve');
  assert.match(approve, /github\.event\.label\.name == 'ci: fork-approved'/);
  assert.match(approve, /head\.repo\.full_name != github\.repository/);
  assert.match(approve, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(approve, /sparse-checkout: scripts\/fork-pr-approval\.mjs/);
  assert.match(approve, /run: node scripts\/fork-pr-approval\.mjs approve/);
  assert.doesNotMatch(source, /ref: \$\{\{ github\.event\.pull_request/);
  assert.doesNotMatch(source, /pnpm|npm (?:ci|install)|npx/);
  assert.match(job(source, 'revoke'), /labels\/ci%3A%20fork-approved/);
  assert.ok(source.includes(`'${APPROVAL_LABEL}'`));
});

test('each required context gates a fork PR on the trusted approval script only', () => {
  for (const [file, name] of [
    ['on-pull-request.yml', 'required-ci'],
    ['postgres-tests.yml', 'postgres-required'],
  ]) {
    const required = job(workflow(file), name);
    assert.match(
      required,
      /FORK_PR: >-\n\s+\$\{\{ github\.event_name == 'pull_request_target' &&\n\s+github\.event\.pull_request\.head\.repo\.full_name != github\.repository \}\}/,
      file,
    );
    const steps = required.split(/^      - name: /m).slice(1);
    const [checkout, gate, ...rest] = steps;
    assert.match(checkout, /^Checkout trusted fork approval gate\n\s+if: env\.FORK_PR == 'true'/, file);
    assert.match(checkout, /ref: \$\{\{ github\.sha \}\}/, file);
    assert.match(gate, /if: env\.FORK_PR == 'true'/, file);
    assert.match(gate, /run: node scripts\/fork-pr-approval\.mjs gate/, file);
    assert.ok(rest.length > 0, file);
    for (const step of rest) {
      assert.match(step, /if: env\.FORK_PR != 'true'/, `${file}: ${step.split('\n')[0]}`);
    }
    assert.match(required, /^      actions: read$/m, file);
  }
});

test('every caller of postgres-tests.yml grants the gate its actions: read', () => {
  for (const file of ['on-demand-validation.yml', 'fork-pr-validation.yml']) {
    const source = workflow(file);
    const caller = source.slice(source.indexOf('uses: ./.github/workflows/postgres-tests.yml'));
    assert.match(caller.split(/^  [a-z]/m)[0], /^      actions: read$/m, file);
  }
});
