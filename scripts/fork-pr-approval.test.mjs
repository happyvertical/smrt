import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  APPROVAL_LABEL,
  APPROVAL_STATUS_CONTEXT,
  approvalProblems,
  fileProblems,
  gateProblems,
  headApprovers,
  REQUIRED_CONTEXTS,
  selectRequiredJobs,
  senderProblems,
} from './fork-pr-approval.mjs';

const HEAD = 'a'.repeat(40);

function input(overrides = {}) {
  return {
    expectedHeadSha: HEAD,
    pr: {
      state: 'open',
      head: { sha: HEAD },
      labels: [{ name: APPROVAL_LABEL }],
      changed_files: 1,
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

const approvalStatus = {
  context: APPROVAL_STATUS_CONTEXT,
  state: 'success',
  creator: { login: 'github-actions[bot]' },
};

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
  assert.deepEqual(gateProblems({ statuses: [approvalStatus], ...input() }), []);
});

test('the gate needs a GitHub Actions approval status on the exact head', () => {
  for (const statuses of [
    [],
    [{ ...approvalStatus, context: 'other' }],
    [{ ...approvalStatus, state: 'pending' }],
    [{ ...approvalStatus, creator: { login: 'some-user' } }],
    // Newest first: a later non-success status supersedes an older approval.
    [{ ...approvalStatus, state: 'failure' }, approvalStatus],
  ]) {
    const problems = gateProblems({ statuses, ...input() });
    assert.equal(problems.length, 1, JSON.stringify(statuses));
    assert.match(problems[0], /awaiting maintainer approval/);
  }
  // An approval of this head does not excuse any other failing condition.
  assert.equal(
    gateProblems({ statuses: [approvalStatus], ...input({ files: [{ filename: '.github/x.yml' }] }) })
      .length,
    1,
  );
});

test('approval binds to an Approve review of the exact head', () => {
  const review = (login, state, commit_id = HEAD) => ({ user: { login }, state, commit_id });
  assert.deepEqual(headApprovers([review('m', 'APPROVED')], HEAD), ['m']);
  // Reviewed an older head: a push after review is not approved.
  assert.deepEqual(headApprovers([review('m', 'APPROVED', 'b'.repeat(40))], HEAD), []);
  // A later blocking or dismissed review replaces the approval; a comment does not.
  assert.deepEqual(headApprovers([review('m', 'APPROVED'), review('m', 'CHANGES_REQUESTED')], HEAD), []);
  assert.deepEqual(headApprovers([review('m', 'APPROVED'), review('m', 'DISMISSED')], HEAD), []);
  assert.deepEqual(headApprovers([review('m', 'APPROVED'), review('m', 'COMMENTED')], HEAD), ['m']);
  assert.deepEqual(
    headApprovers([review('a', 'APPROVED'), review('b', 'CHANGES_REQUESTED')], HEAD),
    ['a'],
  );
  assert.deepEqual(headApprovers([{ state: 'APPROVED', commit_id: HEAD, user: null }], HEAD), []);
});

test('the guard flags .github/ changes and incomplete file lists only', () => {
  const pr = { changed_files: 1 };
  assert.deepEqual(fileProblems(pr, [{ filename: 'src/a.ts' }]), []);
  assert.match(fileProblems(pr, [{ filename: '.github/workflows/x.yml' }])[0], /do not approve/);
  assert.match(fileProblems({ changed_files: 2 }, [{ filename: 'src/a.ts' }])[0], /incomplete/);
});

test('only write, maintain or admin access can approve', () => {
  assert.deepEqual(senderProblems('maint', { permission: 'admin' }), []);
  assert.deepEqual(senderProblems('maint', { permission: 'write' }), []);
  for (const permission of [{ permission: 'read' }, { permission: 'none' }, {}, null]) {
    const problems = senderProblems('someone', permission);
    assert.equal(problems.length, 1, JSON.stringify(permission));
    assert.match(problems[0], /without write access/);
  }
});

test('a truncated or mismatched changed-file list fails closed', () => {
  for (const changed_files of [2, 3000, 3500]) {
    const problems = approvalProblems(input({ pr: { ...input().pr, changed_files } }));
    assert.equal(problems.length, 1, String(changed_files));
    assert.match(problems[0], /incomplete/);
  }
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
    const problems = approvalProblems(input({ files: [file], pr: { ...input().pr, changed_files: 1 } }));
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
  // A workflow-level group would let any label event cancel a pending revoke.
  assert.doesNotMatch(source, /^concurrency:/m);
  const approve = job(source, 'approve');
  assert.match(approve, /^      statuses: write$/m);
  assert.match(approve, /SENDER: \$\{\{ github\.event\.sender\.login \}\}/);
  assert.doesNotMatch(job(source, 'revoke'), /concurrency:/);
  assert.match(approve, /github\.event\.label\.name == 'ci: fork-approved'/);
  assert.match(approve, /head\.repo\.full_name != github\.repository/);
  assert.match(approve, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(approve, /sparse-checkout: scripts\/fork-pr-approval\.mjs/);
  assert.match(approve, /run: node scripts\/fork-pr-approval\.mjs approve/);
  assert.doesNotMatch(source, /ref: \$\{\{ github\.event\.pull_request/);
  assert.doesNotMatch(source, /pnpm|npm (?:ci|install)|npx/);
  assert.match(job(source, 'revoke'), /labels\/ci%3A%20fork-approved/);
  const guard = job(source, 'guard');
  assert.match(guard, /name: Fork Workflow Change Guard/);
  assert.match(guard, /head\.repo\.full_name != github\.repository/);
  assert.match(guard, /run: node scripts\/fork-pr-approval\.mjs guard/);
  assert.doesNotMatch(guard, /: write$/m);
  assert.match(source, /types: \[opened, reopened, synchronize, labeled\]/);
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
      /FORK_PR: >-\n\s+\$\{\{ github\.event_name == 'pull_request' &&\n\s+github\.event\.pull_request\.head\.repo\.full_name != github\.repository( &&\n\s+inputs\.fork_sandbox != true)? \}\}/,
      file,
    );
    const steps = required.split(/^      - name: /m).slice(1);
    const [checkout, gate, ...rest] = steps;
    assert.match(checkout, /^Checkout trusted fork approval gate\n\s+if: env\.FORK_PR == 'true'/, file);
    // On `pull_request` github.sha is the fork-controlled merge commit (#4881).
    assert.match(checkout, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/, file);
    assert.doesNotMatch(checkout, /github\.sha/, file);
    assert.match(gate, /if: env\.FORK_PR == 'true'/, file);
    assert.match(gate, /run: node scripts\/fork-pr-approval\.mjs gate/, file);
    assert.ok(rest.length > 0, file);
    for (const step of rest) {
      assert.match(step, /if: env\.FORK_PR != 'true'/, `${file}: ${step.split('\n')[0]}`);
    }
    assert.match(required, /^      actions: read$/m, file);
    assert.match(required, /^      statuses: read$/m, file);
  }
});

test('only the two no-PR-code workflows keep pull_request_target (#4881)', () => {
  // GitHub blocks pull_request_target on public repositories from 2026-12-02;
  // the repository's Actions event policy allows it for exactly these files
  // (.github/CI.md). Required contexts must come from pull_request runs.
  const dir = new URL('../.github/workflows/', import.meta.url);
  const users = readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .filter((name) => /^\s+pull_request_target:/m.test(workflow(name)))
    .sort();
  assert.deepEqual(users, ['fork-pr-approval.yml', 'merge-queue-watchdog.yml']);
  for (const file of ['on-pull-request.yml', 'postgres-tests.yml']) {
    const source = workflow(file);
    const on = source.slice(source.indexOf('\non:'), source.indexOf('\nconcurrency:'));
    assert.match(on, /^  pull_request:\n    branches: \[main\]\n    types: \[opened, synchronize, reopened\]$/m, file);
    assert.match(on, /^  merge_group:$/m, file);
    assert.doesNotMatch(source, /'pull_request_target'|= pull_request_target\b/, file);
  }
});

test('Fork PR Validation runs the PostgreSQL suites on fork code only via fork_sandbox', () => {
  const source = workflow('postgres-tests.yml');
  assert.match(source, /^      fork_sandbox:\n(?:        .*\n)*?        default: false$/m);
  const decide = job(source, 'scope');
  assert.match(decide, /FORK_SANDBOX: \$\{\{ inputs\.fork_sandbox == true \}\}/);
  assert.match(
    decide,
    /if \[ "\$HEAD_REPO" != "\$REPOSITORY" \] && \[ "\$FORK_SANDBOX" != true \]; then\n\s+trusted=false/,
  );
  const caller = workflow('fork-pr-validation.yml');
  assert.match(
    caller,
    /uses: \.\/\.github\/workflows\/postgres-tests\.yml\n    with:\n      fork_sandbox: true\n/,
  );
  for (const file of ['on-demand-validation.yml', 'on-pull-request.yml']) {
    assert.doesNotMatch(workflow(file), /fork_sandbox/, file);
  }
});

test('every caller of postgres-tests.yml grants the gate its read permissions', () => {
  for (const file of ['on-demand-validation.yml', 'fork-pr-validation.yml']) {
    const source = workflow(file);
    const caller = source.slice(source.indexOf('uses: ./.github/workflows/postgres-tests.yml'));
    const permissions = caller.split(/^  [a-z]/m)[0];
    assert.match(permissions, /^      actions: read$/m, file);
    assert.match(permissions, /^      statuses: read$/m, file);
  }
});
