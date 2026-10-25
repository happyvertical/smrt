import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController, createForge, REPOSITORY, CONTEXT } from './release-admission.mjs';
import { createReleaseAdmissionState, transitionReleaseAdmission as transition } from './release-admission-state.mjs';

const group = 'a'.repeat(40);
const snapshot = 'b'.repeat(40);
const releaseCommit = 'c'.repeat(40);
const owner = { runId: 30, runAttempt: 1 };
const recoveryArtifacts = ['release-candidate-30-1', 'publish-release-pack-30-1-1', 'publish-release-pack-30-1-2'].map((name, index) => ({ id: index + 1, name, digest: `sha256:${String(index + 1).repeat(64)}` }));
const source = { id: 20, workflow_id: 10, path: '.github/workflows/on-pull-request.yml', repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, status: 'completed', conclusion: 'success', head_sha: group, head_branch: 'gh-readonly-queue/main/pr-1', event: 'merge_group', pull_requests: [] };
const bypass_actors = [{ actor_id: 2315871, actor_type: 'Integration', bypass_mode: 'always' }];
const rules = [
  { id: 1, enforcement: 'active', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, bypass_actors, rules: [
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: CONTEXT, integration_id: 2315871 }] } },
    { type: 'merge_queue', parameters: { max_entries_to_build: 1, max_entries_to_merge: 1 } },
  ] },
  { id: 2, enforcement: 'active', target: 'branch', conditions: { ref_name: { include: ['refs/heads/hv-release-admission'], exclude: [] } }, bypass_actors, rules: ['creation', 'update', 'deletion', 'non_fast_forward'].map((type) => ({ type })) },
];
function fixture() {
  let state = createReleaseAdmissionState({ repository: REPOSITORY });
  const events = [];
  let refs = [{ ref: `refs/heads/${source.head_branch}`, object: { sha: group } }];
  let mainSha = snapshot;
  const responses = new Map([
    ['actions/runs/20', structuredClone(source)],
    ['actions/workflows/10', { path: source.path }],
    ['actions/runs/30', { id: 30, workflow_id: 11, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, run_attempt: 1, path: '.github/workflows/on-merge-main.yml', status: 'in_progress' }],
    ['actions/runs/30/attempts/1', { id: 30, workflow_id: 11, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, run_attempt: 1, path: '.github/workflows/on-merge-main.yml', status: 'in_progress' }],
    ['actions/workflows/11', { path: '.github/workflows/on-merge-main.yml' }],
    ['actions/runs/30/artifacts', recoveryArtifacts.map((artifact) => ({ ...artifact, expired: false, workflow_run: { id: 30 } }))],
    [`git/commits/${group}`, { sha: group, parents: [{ sha: snapshot }] }],
    [`compare/${group}...${snapshot}`, { status: 'ahead' }],
    [`commits/${group}/statuses`, []],
    ...rules.map((rule) => [`rulesets/${rule.id}`, structuredClone(rule)]),
  ]);
  const store = {
    async read() { return { revision: String(state.revision), state: structuredClone(state) }; },
    async compareAndSwap(revision, next) {
      assert.equal(revision, String(state.revision));
      events.push(`cas:${next.phase}`); state = next; return true;
    },
  };
  const forge = {
    async request(path) { checkResponse(path); return structuredClone(responses.get(path)); },
    async list(path) { if (path === 'rulesets') return structuredClone(rules); checkResponse(path); return structuredClone(responses.get(path)); },
    async main() { return { protected: true, commit: { sha: mainSha } }; },
    async groups() { return structuredClone(refs); },
    async status(head, status, description) {
      events.push(`status:${status}`); assert.equal(head, group);
      const statuses = responses.get(`commits/${head}/statuses`);
      const result = { id: (statuses[0]?.id ?? 0) + 1, context: CONTEXT, state: status, description,
        creator: { id: 244849939, login: 'have-release-bot[bot]', type: 'Bot' },
        url: `https://api.github.com/repos/${REPOSITORY}/statuses/${head}` };
      statuses.unshift(result); return structuredClone(result);
    },
  };
  function checkResponse(path) { assert.ok(responses.has(path), `Unexpected request ${path}`); }
  const controller = createController({ store, forge, grantOwner: { runId: 300, runAttempt: 1 }, now: () => 100, sleep: async () => { throw new Error('must not wait'); } });
  return { store, forge, controller, responses, events, get state() { return state; }, set state(value) { state = value; }, set refs(value) { refs = value; }, set mainSha(value) { mainSha = value; } };
}

test('admission persists queue head before App success', async () => {
  const f = fixture();
  await f.controller.admit(20);
  assert.deepEqual(f.events, ['cas:open', 'status:success', 'cas:open']);
  assert.equal(f.state.admitted[0].sha, group);
});

test('forged, unsuccessful, wrong workflow and stale base runs cannot admit', async () => {
  for (const change of [ { repository: { full_name: 'attacker/smrt' } }, { conclusion: 'failure' }, { path: 'evil.yml' }, { head_repository: { full_name: 'fork/smrt' } }, { id: 99 } ]) {
    const f = fixture(); Object.assign(f.responses.get('actions/runs/20'), change);
    await assert.rejects(f.controller.admit(20), /Untrusted/);
    assert.deepEqual(f.events, []);
  }
  const f = fixture(); f.mainSha = releaseCommit;
  await assert.rejects(f.controller.admit(20), /Stale/);
  assert.deepEqual(f.events, []);
});

test('CAS failure never writes green; ref disappears after CAS fails closed', async () => {
  const f = fixture(); f.store.compareAndSwap = async () => { throw new Error('cas failure'); };
  await assert.rejects(f.controller.admit(20), /cas failure/);
  assert.deepEqual(f.events, []);
  const g = fixture(); const write = g.store.compareAndSwap;
  g.store.compareAndSwap = async (...args) => { const result = await write(...args); g.refs = []; return result; };
  await assert.rejects(g.controller.admit(20), /Stale/);
  assert.deepEqual(g.events, ['cas:open', 'cas:open']);
});

test('closed window keeps new queue head pending without adding it', async () => {
  const f = fixture(); f.state = transition(f.state, { type: 'close', owner, nowMs: 0, timeoutMs: 1000 });
  await f.controller.admit(20);
  assert.deepEqual(f.events, ['status:pending']);
  assert.deepEqual(f.state.admitted, []);
});

test('completed successful check with live queue ref cannot drain', async () => {
  const f = fixture(); await f.controller.admit(20);
  await assert.rejects(f.controller.close(owner), /must not wait/);
  assert.equal(f.state.phase, 'draining');
  assert.equal(f.state.snapshotSha, null);
});

test('drain resolves vanished heads then freezes protected main', async () => {
  const f = fixture(); await f.controller.admit(20); f.refs = [];
  const current = await f.controller.close(owner);
  assert.equal(current.phase, 'qualifying');
  assert.equal(current.snapshotSha, snapshot);
  assert.equal(current.admitted[0].disposition, 'deleted');
  await f.controller.assertWindow(owner, snapshot);
  await assert.rejects(f.controller.assertWindow({ ...owner, runAttempt: 2 }, snapshot), /mismatch/);
});

test('missing App-bound status or state-ref restriction blocks close', async () => {
  for (const mutate of [
    (f) => { f.responses.get('rulesets/1').rules[0].parameters.required_status_checks[0].integration_id = 15368; },
    (f) => { f.responses.get('rulesets/1').bypass_actors = []; },
    (f) => { f.responses.get('rulesets/2').rules = [{ type: 'deletion' }]; },
    (f) => { f.responses.get('rulesets/2').rules = f.responses.get('rulesets/2').rules.filter((rule) => rule.type !== 'creation'); },
    (f) => { f.responses.get('rulesets/2').bypass_actors.push({ actor_type: 'OrganizationAdmin', bypass_mode: 'always' }); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.controller.close(owner), /Provision|Protect/);
    assert.equal(f.state.phase, 'open');
  }
});

test('PR target empty association uses exact independently queried current PR head', async () => {
  const f = fixture(); f.responses.get('actions/runs/20').event = 'pull_request_target';
  const pr = { number: 5, state: 'open', head: { sha: group, repo: { full_name: REPOSITORY } }, base: { ref: 'main', repo: { full_name: REPOSITORY } } };
  f.responses.set(`commits/${group}/pulls`, [pr]); f.responses.set('pulls/5', pr);
  await f.controller.admit(20);
  assert.deepEqual(f.events, ['cas:open', 'status:success', 'cas:open']);
  assert.equal(f.state.admitted[0].sha, group);
  assert.equal(f.state.admitted[0].grant, null);
  pr.head.sha = snapshot; f.responses.set('pulls/5', pr);
  await assert.rejects(f.controller.admit(20), /[Ss]tale/);
});

test('partial publication abort enters recovery; exact source completion cannot take over other attempt', async () => {
  const f = fixture();
  f.state = transition(f.state, { type: 'close', owner, nowMs: 0, timeoutMs: 1000 });
  f.state = transition(f.state, { type: 'freeze', owner, nowMs: 100, main: { authenticated: true, repository: REPOSITORY, protected: true, ref: 'refs/heads/main', sha: snapshot } });
  const release = { snapshotSha: snapshot, releaseCommitSha: releaseCommit, version: '1.0.0', ref: 'refs/tags/v1.0.0', recoveryArtifacts };
  f.state = transition(f.state, { type: 'beginPublishing', owner, nowMs: 100, release, qualification: { authenticated: true, repository: REPOSITORY, snapshotSha: snapshot, success: true } });
  f.responses.set('actions/runs/30/attempts/2', { id: 30, workflow_id: 11, repository: { full_name: REPOSITORY }, path: '.github/workflows/on-merge-main.yml', status: 'completed', run_attempt: 2 });
  f.responses.set('actions/workflows/11', { path: '.github/workflows/on-merge-main.yml' });
  await f.controller.finishRun(30, 2); assert.equal(f.state.phase, 'publishing');
  f.responses.get('actions/runs/30/attempts/1').status = 'completed';
  await f.controller.finishRun(30, 1); assert.equal(f.state.phase, 'recovery');
  assert.equal(f.state.owner.runAttempt, 1);
  await f.controller.abort(owner); assert.equal(f.state.phase, 'recovery');
});

test('complete requires primary registry content and exact remote release lineage', async () => {
  const f = fixture();
  const release = { snapshotSha: snapshot, releaseCommitSha: releaseCommit, version: '1.0.0', ref: 'refs/tags/v1.0.0', recoveryArtifacts };
  f.state = transition(f.state, { type: 'close', owner, nowMs: 0, timeoutMs: 1000 });
  f.state = transition(f.state, { type: 'freeze', owner, nowMs: 100, main: { authenticated: true, repository: REPOSITORY, protected: true, ref: 'refs/heads/main', sha: snapshot } });
  f.state = transition(f.state, { type: 'beginPublishing', owner, nowMs: 100, release, qualification: { authenticated: true, repository: REPOSITORY, snapshotSha: snapshot, success: true } });
  f.mainSha = releaseCommit;
  f.responses.set('git/ref/tags/v1.0.0', { object: { type: 'commit', sha: releaseCommit } });
  f.responses.set(`git/commits/${releaseCommit}`, { sha: releaseCommit, parents: [{ sha: snapshot }] });
  const directory = mkdtempSync(join(tmpdir(), 'admission-test-'));
  try {
    const path = join(directory, 'package.tgz'); writeFileSync(path, 'verified package');
    let integrity = 'sha512-wrong';
    const controller = createController({ store: f.store, forge: f.forge,
      verifyArtifacts: () => ({ releaseVersion: '1.0.0', packages: [{ name: '@happyvertical/test', version: '1.0.0', path }] }),
      registryMetadata: () => ({ name: '@happyvertical/test', version: '1.0.0', dist: { integrity } }),
    });
    await assert.rejects(controller.complete(owner, { artifactDir: directory }), /content mismatch/);
    assert.equal(f.state.phase, 'publishing');
    integrity = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
    const originalArtifact = f.responses.get('actions/runs/30/artifacts')[0];
    originalArtifact.expired = true;
    await assert.rejects(controller.complete(owner, { artifactDir: directory }), /expired/);
    originalArtifact.expired = false;
    const originalDigest = originalArtifact.digest;
    originalArtifact.digest = `sha256:${'f'.repeat(64)}`;
    await assert.rejects(controller.complete(owner, { artifactDir: directory }), /differ from original/);
    assert.equal(f.state.phase, 'publishing');
    originalArtifact.digest = originalDigest;
    // Latest normal rerun has advanced. Explicit recovery still verifies the
    // immutable original attempt and its original bound artifacts.
    f.responses.set('actions/runs/30', { ...f.responses.get('actions/runs/30/attempts/1'), run_attempt: 2 });
    f.state = transition(f.state, { type: 'abort', owner });
    assert.equal(f.state.phase, 'recovery');
    await controller.complete(owner, { artifactDir: directory });
    assert.equal(f.state.phase, 'open');
    assert.deepEqual(f.state.lastRelease, release);
  } finally { rmSync(directory, { recursive: true }); }
});

test('forge separates read/write tokens and reports missing App status permission', async () => {
  const calls = [];
  const forge = createForge({ readToken: 'actions', writeToken: 'app', fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); return { ok: options.method === 'GET', status: options.method === 'GET' ? 200 : 403, json: async () => ({}) };
  } });
  await forge.main();
  await assert.rejects(forge.status(group, 'success', 'admitted'), /App requires statuses:write/);
  assert.equal(calls[0].headers.Authorization, 'Bearer actions');
  assert.equal(calls[1].headers.Authorization, 'Bearer app');
  assert.throws(() => createForge({ readToken: 'same', writeToken: 'same' }), /Separate/);
});

test('controller workflow only checks out trusted main without credentials or artifact execution', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-admission.yml', import.meta.url), 'utf8');
  assert.match(workflow, /ref: refs\/heads\/main/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /CI_RELEASE_WINDOW_ENABLED == 'true'/);
  assert.match(workflow, /finish-run --run-id/);
  assert.doesNotMatch(workflow, /download-artifact|npm install|pnpm install|workflow_run.head_sha/);
});

test('already admitted green group remains admitted while window drains', async () => {
  const f = fixture(); await f.controller.admit(20);
  f.state = transition(f.state, { type: 'close', owner, nowMs: 0, timeoutMs: 1000 });
  f.events.length = 0;
  await f.controller.admit(20);
  assert.deepEqual(f.events, []);
  assert.equal(f.state.phase, 'draining');
  assert.equal(f.state.admitted.length, 1);
});

test('begin publication refuses wrong source parent, missing artifacts and expired owner before writes', async () => {
  const f = fixture(); f.refs = [];
  await f.controller.close(owner);
  let parent = group;
  const controller = createController({ store: f.store, forge: f.forge, now: () => 100,
    git: (args) => args[0] === 'rev-parse' ? releaseCommit : `${releaseCommit} ${parent}`,
    verifyArtifacts: () => { throw new Error('Artifacts are not qualified'); },
  });
  await assert.rejects(controller.beginPublishing(owner, { snapshotSha: snapshot, version: JSON.parse(readFileSync('package.json', 'utf8')).version, artifactDir: 'artifacts' }), /exactly the frozen source/);
  parent = snapshot;
  await assert.rejects(controller.beginPublishing(owner, { snapshotSha: snapshot, version: JSON.parse(readFileSync('package.json', 'utf8')).version, artifactDir: 'artifacts' }), /Artifacts are not qualified/);
  await assert.rejects(controller.beginPublishing({ ...owner, runAttempt: 2 }, { snapshotSha: snapshot }), /owner\/snapshot/);
  assert.equal(f.state.phase, 'qualifying');
});

test('successful no-change release completion reopens qualifying window', async () => {
  const f = fixture(); f.refs = []; await f.controller.close(owner);
  f.responses.set('actions/runs/30/attempts/1', { id: 30, workflow_id: 11, repository: { full_name: REPOSITORY }, path: '.github/workflows/on-merge-main.yml', status: 'completed', conclusion: 'success', run_attempt: 1 });
  f.responses.set('actions/workflows/11', { path: '.github/workflows/on-merge-main.yml' });
  await f.controller.finishRun(30, 1);
  assert.equal(f.state.phase, 'open');
  await f.controller.finishRun(30, 1);
  assert.equal(f.state.phase, 'open');
});

test('scheduled reconciliation repairs dropped release completion and PR success events', async () => {
  const f = fixture(); f.refs = []; await f.controller.close(owner);
  f.responses.set('actions/runs/30/attempts/1', { id: 30, workflow_id: 11, repository: { full_name: REPOSITORY }, path: '.github/workflows/on-merge-main.yml', status: 'completed', conclusion: 'success', run_attempt: 1 });
  f.responses.set('actions/workflows/11', { path: '.github/workflows/on-merge-main.yml' });
  f.responses.get('actions/runs/20').event = 'pull_request_target';
  const pr = { number: 5, state: 'open', head: { sha: group, repo: { full_name: REPOSITORY } }, base: { ref: 'main', repo: { full_name: REPOSITORY } } };
  f.responses.set('pulls?state=open&base=main', [pr]);
  f.responses.set(`commits/${group}/pulls`, [pr]);
  f.responses.set('pulls/5', pr);
  f.responses.set(`actions/workflows/on-pull-request.yml/runs?head_sha=${group}&status=success`, [f.responses.get('actions/runs/20')]);
  f.events.length = 0;
  await f.controller.reconcile();
  assert.equal(f.state.phase, 'open');
  assert.deepEqual(f.events, ['cas:open', 'cas:open', 'status:success', 'cas:open']);
});

test('scheduled reconciliation retries dropped merge-group status from live refs', async () => {
  const f = fixture();
  f.responses.set('pulls?state=open&base=main', []);
  f.responses.set(`actions/workflows/on-pull-request.yml/runs?head_sha=${group}&status=success`, [source]);
  await f.controller.reconcile();
  assert.deepEqual(f.events, ['cas:open', 'status:success', 'cas:open']);
});

test('scheduled owner polling never reopens publication or takes over another attempt', async () => {
  for (const runAttempt of [1, 2]) {
    const f = fixture(); f.refs = []; await f.controller.close(owner);
    f.state = transition(f.state, { type: 'beginPublishing', owner, nowMs: 100, release: { snapshotSha: snapshot, releaseCommitSha: releaseCommit, version: '1.0.0', ref: 'refs/tags/v1.0.0', recoveryArtifacts }, qualification: { authenticated: true, repository: REPOSITORY, snapshotSha: snapshot, success: true } });
    f.responses.set('actions/runs/30/attempts/1', { id: 30, workflow_id: 11, repository: { full_name: REPOSITORY }, path: '.github/workflows/on-merge-main.yml', status: 'completed', run_attempt: runAttempt });
    f.responses.set('actions/workflows/11', { path: '.github/workflows/on-merge-main.yml' });
    if (runAttempt === 1) {
      await f.controller.reconcile(); assert.equal(f.state.phase, 'recovery');
    } else {
      await assert.rejects(f.controller.reconcile(), /reviewed recovery/); assert.equal(f.state.phase, 'publishing');
    }
    assert.deepEqual(f.state.owner, owner);
  }
});

test('active prepublication owner expires at the deadline despite an in-progress run', async () => {
  for (const phase of ['draining', 'qualifying']) {
    const f = fixture(); f.refs = [];
    if (phase === 'qualifying') await f.controller.close(owner);
    else f.state = transition(f.state, { type: 'close', owner, nowMs: 100, timeoutMs: 1000 });
    f.responses.set('pulls?state=open&base=main', []);
    const controller = createController({ store: f.store, forge: f.forge, now: () => f.state.deadlineMs ?? 99_999_999 });
    await controller.reconcile();
    assert.equal(f.state.phase, 'open');
    assert.equal(f.state.lastWindow.outcome, 'aborted');
    assert.deepEqual(f.state.lastWindow.owner, owner);
  }
});

test('deadline CAS race with publication enters recovery and never reopens', async () => {
  const f = fixture(); f.refs = []; await f.controller.close(owner);
  const deadline = f.state.deadlineMs;
  const originalSwap = f.store.compareAndSwap;
  let raced = false;
  f.store.compareAndSwap = async (revision, next) => {
    if (!raced) {
      raced = true;
      f.state = transition(f.state, { type: 'beginPublishing', owner, nowMs: deadline - 1, release: { snapshotSha: snapshot, releaseCommitSha: releaseCommit, version: '1.0.0', ref: 'refs/tags/v1.0.0', recoveryArtifacts }, qualification: { authenticated: true, repository: REPOSITORY, snapshotSha: snapshot, success: true } });
      return false;
    }
    return originalSwap(revision, next);
  };
  f.responses.set('actions/runs/30/attempts/1', { id: 30, status: 'in_progress', run_attempt: 1 });
  const controller = createController({ store: f.store, forge: f.forge, now: () => deadline });
  await controller.reconcile();
  assert.equal(raced, true);
  assert.equal(f.state.phase, 'recovery');
  assert.deepEqual(f.state.owner, owner);
});

test('reconciliation attempts all current heads before reporting a broken source', async () => {
  const f = fixture();
  f.responses.set('pulls?state=open&base=main', [{ head: { sha: snapshot, repo: { full_name: REPOSITORY } } }]);
  f.responses.set(`actions/workflows/on-pull-request.yml/runs?head_sha=${snapshot}&status=success`, [{ ...source, head_sha: snapshot, event: 'pull_request_target' }]);
  f.responses.set(`actions/workflows/on-pull-request.yml/runs?head_sha=${group}&status=success`, [source]);
  f.responses.get('actions/runs/20').conclusion = 'failure';
  await assert.rejects(f.controller.reconcile(), /incomplete \(2 heads\)/);
  assert.deepEqual(f.events, []);
});

test('vanished queue refs drain without looking up expired queue commit ancestry', async () => {
  const f = fixture(); await f.controller.admit(20); f.refs = [];
  f.responses.delete(`compare/${group}...${snapshot}`);
  await f.controller.close(owner);
  assert.equal(f.state.phase, 'qualifying');
  assert.equal(f.state.admitted[0].disposition, 'deleted');
});

test('GitHub pagination inventories all pages and rejects truncated validation search', async () => {
  let calls = 0;
  const forge = createForge({ readToken: 'actions', writeToken: 'app', fetchImpl: async () => {
    calls++;
    return { ok: true, status: 200, json: async () => calls === 1 ? Array(100).fill({ number: 1 }) : [{ number: 2 }] };
  } });
  assert.equal((await forge.list('pulls?state=open&base=main')).length, 101);
  assert.equal(calls, 2);
  const truncated = createForge({ readToken: 'actions', writeToken: 'app', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ total_count: 1001, workflow_runs: Array(100).fill(source) }) }) });
  await assert.rejects(truncated.list('actions/workflows/on-pull-request.yml/runs', 'workflow_runs'), /search limit; narrow reconciliation/);
});

test('begin publication binds exact originating run/attempt recovery artifact IDs and digests', async () => {
  const f = fixture(); f.refs = []; await f.controller.close(owner);
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const controller = createController({ store: f.store, forge: f.forge, now: () => 100,
    git: (args) => args[0] === 'rev-parse' ? releaseCommit : `${releaseCommit} ${snapshot}`,
    verifyArtifacts: () => ({ releaseVersion: version, packages: [{ name: '@happyvertical/test', version }] }),
  });
  await controller.beginPublishing(owner, { snapshotSha: snapshot, version, artifactDir: 'artifacts' });
  assert.equal(f.state.phase, 'publishing');
  assert.deepEqual(f.state.release.recoveryArtifacts, recoveryArtifacts);
});

test('missing, duplicate, expired, forged or wrong-attempt recovery artifacts cannot begin publication', async () => {
  for (const mutate of [
    (f) => f.responses.get('actions/runs/30/artifacts').pop(),
    (f) => f.responses.get('actions/runs/30/artifacts').push(f.responses.get('actions/runs/30/artifacts')[0]),
    (f) => { f.responses.get('actions/runs/30/artifacts')[0].expired = true; },
    (f) => { f.responses.get('actions/runs/30/artifacts')[0].digest = 'sha256:forged'; },
    (f) => { f.responses.get('actions/runs/30/artifacts')[0].workflow_run.id = 99; },
    (f) => { f.responses.get('actions/runs/30/attempts/1').run_attempt = 2; },
    (f) => { f.responses.get('actions/runs/30/attempts/1').head_repository.full_name = 'fork/smrt'; },
  ]) {
    const f = fixture(); f.refs = []; await f.controller.close(owner); mutate(f);
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
    const controller = createController({ store: f.store, forge: f.forge, now: () => 100,
      git: (args) => args[0] === 'rev-parse' ? releaseCommit : `${releaseCommit} ${snapshot}`,
      verifyArtifacts: () => ({ releaseVersion: version, packages: [{ name: '@happyvertical/test', version }] }),
    });
    await assert.rejects(controller.beginPublishing(owner, { snapshotSha: snapshot, version, artifactDir: 'artifacts' }), /artifact|originating/);
    assert.equal(f.state.phase, 'qualifying');
  }
});

test('disappear then freeze revokes green before same queue SHA reappears', async () => {
  const f = fixture(); await f.controller.admit(20); f.refs = [];
  f.events.length = 0;
  await f.controller.close(owner);
  assert.deepEqual(f.events, ['cas:draining', 'status:pending', 'cas:draining', 'cas:qualifying']);
  assert.equal(f.state.admitted[0].disposition, 'deleted');
  f.refs = [{ ref: `refs/heads/${source.head_branch}`, object: { sha: group } }];
  f.events.length = 0;
  await f.controller.admit(20);
  await f.controller.admit(20);
  assert.deepEqual(f.events, ['status:pending']);
  assert.equal(f.state.phase, 'qualifying');
});

test('duplicate validation completion after publishing/recovery cannot regrant drained SHA', async () => {
  const f = fixture(); await f.controller.admit(20); f.refs = []; await f.controller.close(owner);
  f.refs = [{ ref: `refs/heads/${source.head_branch}`, object: { sha: group } }];
  f.state = transition(f.state, { type: 'beginPublishing', owner, nowMs: 100, release: { snapshotSha: snapshot, releaseCommitSha: releaseCommit, version: '1.0.0', ref: 'refs/tags/v1.0.0', recoveryArtifacts }, qualification: { authenticated: true, repository: REPOSITORY, snapshotSha: snapshot, success: true } });
  f.events.length = 0;
  await f.controller.admit(20);
  assert.equal(f.state.phase, 'publishing');
  f.state = transition(f.state, { type: 'abort', owner });
  await f.controller.admit(20);
  assert.equal(f.state.phase, 'recovery');
  assert.deepEqual(f.events, ['status:pending']);
});

test('failed drained-head status revocation prevents resolution and snapshot freeze', async () => {
  const f = fixture(); await f.controller.admit(20); f.refs = [];
  f.forge.status = async () => { throw new Error('App status unavailable'); };
  await assert.rejects(f.controller.close(owner), /App status unavailable/);
  assert.equal(f.state.phase, 'draining');
  assert.equal(f.state.admitted[0].disposition, 'pending');
  assert.equal(f.state.snapshotSha, null);
});

test('delayed initial success POST must settle before close can revoke and freeze', async () => {
  const f = fixture();
  let acknowledge;
  let entered;
  const posting = new Promise((resolve) => { entered = resolve; });
  const originalStatus = f.forge.status;
  f.forge.status = async (head, status, description) => {
    if (status === 'success') {
      entered();
      await new Promise((resolve) => { acknowledge = resolve; });
    }
    return originalStatus(head, status, description);
  };
  const admission = f.controller.admit(20);
  await posting;
  const grant = structuredClone(f.state.admitted[0].grant);
  assert.equal(grant.runId, 300);
  assert.equal(grant.validationRunId, 20);
  f.refs = [];
  await assert.rejects(f.controller.close(owner), /must not wait/);
  assert.equal(f.state.phase, 'draining');
  assert.equal(f.state.snapshotSha, null);
  assert.deepEqual(f.state.admitted[0].grant, grant);
  assert.equal(f.events.includes('status:pending'), false);
  acknowledge(); await admission;
  assert.equal(f.state.admitted[0].grant, null);
  await f.controller.close(owner);
  assert.equal(f.state.phase, 'qualifying');
  assert.ok(f.events.indexOf('status:success') < f.events.indexOf('status:pending'));
});

test('duplicate open callbacks cannot reserve/write green over an unsettled grant', async () => {
  const f = fixture();
  let acknowledge;
  let entered;
  const posting = new Promise((resolve) => { entered = resolve; });
  let successPosts = 0;
  f.forge.status = async (_head, status) => {
    if (status === 'success') {
      successPosts++;
      entered(); await new Promise((resolve) => { acknowledge = resolve; });
    }
  };
  const first = f.controller.admit(20);
  await posting;
  await assert.rejects(f.controller.admit(20), /status-grant-unsettled/);
  assert.equal(successPosts, 1);
  acknowledge(); await first;
  assert.equal(f.state.admitted[0].grant, null);
});

test('unknown status POST result retains exact grant through prepublication timeout', async () => {
  const f = fixture();
  f.forge.status = async () => { throw new Error('POST result unknown'); };
  await assert.rejects(f.controller.admit(20), /POST result unknown/);
  const grant = structuredClone(f.state.admitted[0].grant);
  f.state = transition(f.state, { type: 'close', owner, nowMs: 100, timeoutMs: 1000 });
  f.state = transition(f.state, { type: 'timeout', owner, nowMs: 1100 });
  assert.equal(f.state.phase, 'open');
  assert.deepEqual(f.state.admitted[0].grant, grant);
  await assert.rejects(f.controller.admit(20), /status-grant-unsettled/);
});

function makePr(f) {
  f.responses.get('actions/runs/20').event = 'pull_request_target';
  const pr = { number: 5, state: 'open', head: { sha: group, repo: { full_name: REPOSITORY } }, base: { ref: 'main', repo: { full_name: REPOSITORY } } };
  f.responses.set(`commits/${group}/pulls`, [pr]);
  f.responses.set('pulls/5', pr);
}

test('delayed PR green write shares queue close barrier and nonce evidence', async () => {
  const f = fixture(); makePr(f); f.refs = [];
  let acknowledge;
  let entered;
  const posting = new Promise((resolve) => { entered = resolve; });
  const originalStatus = f.forge.status;
  f.forge.status = async (head, status, description) => {
    if (status === 'success') {
      assert.equal(description, `Validated admission grant ${f.state.admitted[0].grant.id}`);
      assert.ok(description.length <= 140);
      entered(); await new Promise((resolve) => { acknowledge = resolve; });
    }
    return originalStatus(head, status, description);
  };
  const admission = f.controller.admit(20);
  await posting;
  await assert.rejects(f.controller.close(owner), /must not wait/);
  assert.equal(f.state.phase, 'draining');
  acknowledge(); await admission;
  await f.controller.close(owner);
  assert.equal(f.state.phase, 'qualifying');
  assert.ok(f.events.indexOf('status:success') < f.events.indexOf('status:pending'));
});

test('a drained queue SHA reused as a validated PR head stays pending while closed', async () => {
  const f = fixture(); await f.controller.admit(20); f.refs = []; await f.controller.close(owner);
  makePr(f);
  f.events.length = 0;
  await f.controller.admit(20);
  assert.deepEqual(f.events, ['status:pending']);
  assert.equal(f.state.phase, 'qualifying');
  assert.equal(f.state.admitted[0].disposition, 'deleted');
});

async function strandedGrant() {
  const f = fixture();
  let description;
  f.forge.status = async (_head, _state, message) => { description = message; throw new Error('Acknowledgement lost'); };
  await assert.rejects(f.controller.admit(20), /Acknowledgement lost/);
  const grant = structuredClone(f.state.admitted[0].grant);
  f.responses.set('actions/runs/300/attempts/1', { id: 300, run_attempt: 1, workflow_id: 40, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, path: '.github/workflows/release-admission.yml', status: 'completed' });
  f.responses.set('actions/workflows/40', { path: '.github/workflows/release-admission.yml' });
  f.responses.set(`commits/${group}/statuses`, [{ id: 90, context: CONTEXT, state: 'success', description, creator: { id: 244849939, login: 'have-release-bot[bot]', type: 'Bot' }, url: `https://api.github.com/repos/${REPOSITORY}/statuses/${group}` }]);
  return { f, grant, options: { head: group, grantId: grant.id, writerRunId: 300, writerRunAttempt: 1 } };
}

test('explicit ack-grant settles only an exact committed App success without reposting green', async () => {
  const { f, options } = await strandedGrant();
  f.forge.status = async () => { throw new Error('ack must never write a status'); };
  await f.controller.ackGrant(options);
  assert.equal(f.state.admitted[0].grant, null);
  assert.equal(f.state.phase, 'open');
});

test('ack-grant rejects missing/forged evidence, live writers and mismatched saved identity', async () => {
  for (const mutate of [
    (f) => { f.responses.set(`commits/${group}/statuses`, []); },
    (f) => { f.responses.get(`commits/${group}/statuses`)[0].creator.id = 15368; },
    (f) => { f.responses.get(`commits/${group}/statuses`)[0].description = `Validated admission grant ${'f'.repeat(32)}`; },
    (f) => { f.responses.get(`commits/${group}/statuses`)[0].state = 'pending'; },
    (f) => { f.responses.get(`commits/${group}/statuses`)[0].context = 'Required CI'; },
    (f) => { f.responses.get(`commits/${group}/statuses`)[0].url = `https://api.github.com/repos/${REPOSITORY}/statuses/${snapshot}`; },
    (f) => { f.responses.get('actions/runs/300/attempts/1').status = 'in_progress'; },
    (f) => { f.responses.get('actions/runs/300/attempts/1').path = '.github/workflows/evil.yml'; },
    (_f, options) => { options.writerRunAttempt = 2; },
    (_f, options) => { options.grantId = 'f'.repeat(32); },
  ]) {
    const { f, grant, options } = await strandedGrant(); mutate(f, options);
    await assert.rejects(f.controller.ackGrant(options), /evidence missing|writer must|identity mismatch/);
    assert.deepEqual(f.state.admitted[0].grant, grant);
  }
});

test('repeated PR and group reconciliation reuses one acknowledged window status', async () => {
  for (const isPr of [false, true]) {
    const f = fixture(); if (isPr) makePr(f);
    f.responses.set('pulls?state=open&base=main', isPr ? [f.responses.get('pulls/5')] : []);
    f.responses.set(`actions/workflows/on-pull-request.yml/runs?head_sha=${group}&status=success`, [f.responses.get('actions/runs/20')]);
    await f.controller.reconcile();
    const revision = f.state.revision;
    for (let index = 0; index < 4; index++) await f.controller.reconcile();
    assert.equal(f.events.filter((event) => event === 'status:success').length, 1);
    assert.equal(f.state.revision, revision);
    assert.match(f.state.admitted[0].windowGrantId, /^[a-f0-9]{32}$/);
  }
});

test('latest authenticated pending overrides historical grant success and pending retries dedupe', async () => {
  const f = fixture(); await f.controller.admit(20);
  const oldId = f.state.admitted[0].windowGrantId;
  await f.forge.status(group, 'pending', 'Release window closed; awaiting admission');
  await f.controller.admit(20);
  assert.notEqual(f.state.admitted[0].windowGrantId, oldId);
  f.state = transition(f.state, { type: 'close', owner, nowMs: 100, timeoutMs: 1000 });
  f.state = transition(f.state, { type: 'observeGroup', owner, facts: { authenticated: true, repository: REPOSITORY, sha: group, refExists: false, disposition: 'deleted' } });
  f.events.length = 0;
  await f.controller.admit(20); await f.controller.admit(20);
  assert.deepEqual(f.events, ['status:pending']);
});

test('one uninterrupted close observes a delayed grant acknowledgement', async () => {
  const f = fixture();
  let releasePost; let entered;
  const posting = new Promise((resolve) => { entered = resolve; });
  const original = f.forge.status;
  f.forge.status = async (...args) => {
    if (args[1] === 'success') { entered(); await new Promise((resolve) => { releasePost = resolve; }); }
    return original(...args);
  };
  const admission = f.controller.admit(20); await posting; f.refs = [];
  let polls = 0;
  const closer = createController({ store: f.store, forge: f.forge, now: () => 100,
    sleep: async () => { assert.equal(++polls, 1, 'drain failed to refresh acknowledged grant'); releasePost(); await admission; } });
  await closer.close(owner);
  assert.equal(f.state.phase, 'qualifying');
  assert.ok(f.events.indexOf('status:success') < f.events.indexOf('status:pending'));
});

test('old close stops when its owner changes during a grant poll', async () => {
  const f = fixture();
  f.forge.status = async () => { throw new Error('unknown'); };
  await assert.rejects(f.controller.admit(20), /unknown/); f.refs = [];
  let polls = 0;
  const closer = createController({ store: f.store, forge: f.forge, now: () => 100,
    sleep: async () => {
      assert.equal(++polls, 1, 'unexpected extra poll');
      f.state = transition(f.state, { type: 'abort', owner });
      f.state = transition(f.state, { type: 'close', owner: { ...owner, runAttempt: 2 }, nowMs: 100, timeoutMs: 1000 });
    } });
  await assert.rejects(closer.close(owner), /owner/);
  assert.equal(f.state.owner.runAttempt, 2);
});

test('late old-window grant finish and manual acknowledgement cannot seed reopened window reuse', async () => {
  for (const manual of [false, true]) {
    const { f, grant, options } = await strandedGrant();
    assert.equal(f.state.admitted[0].windowGrantId, grant.id);
    f.state = transition(f.state, { type: 'close', owner, nowMs: 100, timeoutMs: 1000 });
    f.state = transition(f.state, { type: 'abort', owner });
    if (manual) await f.controller.ackGrant(options);
    else f.state = transition(f.state, { type: 'finishGrant', sha: group, grant });
    assert.equal(f.state.admitted[0].windowGrantId, null);
  }
});

test('definitive status rejection cancels exact grant while ambiguous POST remains fenced', async () => {
  for (const status of [403, 422, 408, 500, 302, 'network', 'malformed']) {
    const f = fixture();
    const api = createForge({ readToken: 'read', writeToken: 'app', fetchImpl: async () => {
      if (status === 'network') throw new Error('network unknown');
      return { ok: status === 'malformed', status: status === 'malformed' ? 201 : status,
        json: async () => ({}) };
    } });
    f.forge.status = api.status;
    await assert.rejects(f.controller.admit(20));
    assert.equal(f.state.admitted[0].grant === null, [403, 422].includes(status), String(status));
    if ([403, 422].includes(status)) assert.equal(f.state.admitted[0].windowGrantId, null);
  }
});

test('reservation losing to concurrent completed acknowledgement never posts its own nonce', async () => {
  const f = fixture();
  const original = f.store.compareAndSwap;
  let raced = false;
  const winner = { id: 'e'.repeat(32), runId: 301, runAttempt: 1, validationRunId: 20 };
  f.store.compareAndSwap = async (revision, next) => {
    if (!raced) {
      raced = true;
      f.state = transition(f.state, { type: 'reserveGrant', sha: group, grant: winner });
      await f.forge.status(group, 'success', `Validated admission grant ${winner.id}`);
      f.state = transition(f.state, { type: 'finishGrant', sha: group, grant: winner });
      return false;
    }
    return original(revision, next);
  };
  await f.controller.admit(20);
  assert.equal(f.events.filter((event) => event === 'status:success').length, 1);
  assert.equal(f.state.admitted[0].windowGrantId, winner.id);
  assert.equal(f.state.admitted[0].grant, null);
});

test('reuse requires live validation and exact latest App status identity', async () => {
  for (const mutate of [
    (f) => { f.responses.get(`commits/${group}/statuses`)[0].creator.id = 15368; },
    (f) => { f.responses.get(`commits/${group}/statuses`)[0].context = 'Required CI'; },
    (f) => { f.responses.get(`commits/${group}/statuses`)[0].description = `Validated admission grant ${'f'.repeat(32)}`; },
    (f) => { f.responses.get(`commits/${group}/statuses`)[0].url = `https://api.github.com/repos/${REPOSITORY}/statuses/${snapshot}`; },
    (f) => { f.responses.set(`commits/${group}/statuses`, []); },
    (f) => { delete f.state.admitted[0].windowGrantId; },
  ]) {
    const f = fixture(); await f.controller.admit(20); mutate(f);
    await f.controller.admit(20);
    assert.equal(f.events.filter((event) => event === 'status:success').length, 2);
  }
  const f = fixture(); await f.controller.admit(20);
  const initial = f.forge.groups; let reads = 0;
  f.forge.groups = async () => ++reads === 1 ? initial() : [];
  await assert.rejects(f.controller.admit(20), /Stale/);
  assert.equal(f.events.filter((event) => event === 'status:success').length, 1);
});

test('reopen requires a fresh nonce even when previous successful status is unchanged', async () => {
  const f = fixture(); await f.controller.admit(20);
  const before = f.state.admitted[0].windowGrantId;
  f.state = transition(f.state, { type: 'close', owner, nowMs: 100, timeoutMs: 1000 });
  f.state = transition(f.state, { type: 'abort', owner });
  await f.controller.admit(20);
  assert.notEqual(f.state.admitted[0].windowGrantId, before);
  assert.equal(f.events.filter((event) => event === 'status:success').length, 2);
});

test('manual acknowledgement of historical success cannot bypass later pending revocation', async () => {
  const { f, options } = await strandedGrant();
  // Append a newer pending status using this fixture's actual inventory.
  f.responses.get(`commits/${group}/statuses`).unshift({
    ...f.responses.get(`commits/${group}/statuses`)[0], id: 91, state: 'pending', description: 'revoked',
  });
  await f.controller.ackGrant(options);
  let posts = 0;
  f.forge.status = async () => { posts++; };
  await f.controller.admit(20);
  assert.equal(posts, 1);
  assert.notEqual(f.state.admitted[0].windowGrantId, options.grantId);
});

test('exhausted status quota still blocks drain when pending revocation is rejected', async () => {
  const f = fixture(); await f.controller.admit(20); f.refs = [];
  f.forge.status = createForge({ readToken: 'read', writeToken: 'app', fetchImpl: async () => ({ ok: false, status: 422 }) }).status;
  await assert.rejects(f.controller.close(owner), /422/);
  assert.equal(f.state.phase, 'draining');
  assert.equal(f.state.admitted[0].disposition, 'pending');
  assert.equal(f.state.snapshotSha, null);
});

test('definitive rejection cleanup cannot clear a different concurrent reservation', async () => {
  const f = fixture();
  let originalGrant;
  f.forge.status = async () => {
    originalGrant = structuredClone(f.state.admitted[0].grant);
    f.state = transition(f.state, { type: 'cancelGrant', sha: group, grant: originalGrant });
    f.state = transition(f.state, { type: 'reserveGrant', sha: group, grant: { ...originalGrant, id: 'f'.repeat(32) } });
    throw Object.assign(new Error('rejected'), { statusWriteRejected: true });
  };
  await assert.rejects(f.controller.admit(20), /status-grant-owner-mismatch/);
  assert.equal(f.state.admitted[0].grant.id, 'f'.repeat(32));
});

test('definitive rejection crossing close clears its exact fence without restoring window identity', async () => {
  const f = fixture();
  const original = f.forge.status;
  f.forge.status = async () => {
    f.state = transition(f.state, { type: 'close', owner, nowMs: 100, timeoutMs: 1000 });
    throw Object.assign(new Error('quota rejected'), { statusWriteRejected: true });
  };
  await assert.rejects(f.controller.admit(20), /quota rejected/);
  assert.equal(f.state.phase, 'draining');
  assert.equal(f.state.admitted[0].grant, null);
  assert.equal(f.state.admitted[0].windowGrantId, null);
  f.forge.status = original; f.refs = [];
  await f.controller.close(owner);
  assert.equal(f.state.phase, 'qualifying');
});

test('read-only window assertions need no App token and cannot send any mutation', async () => {
  const calls = [];
  const forge = createForge({ readToken: 'actions-read-only', readOnly: true, fetchImpl: async (_url, options) => {
    calls.push(options);
    return { ok: true, status: 200, json: async () => ({ protected: true, commit: { sha: snapshot } }) };
  } });
  await forge.main();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, 'Bearer actions-read-only');
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    await assert.rejects(forge.request('statuses/head', { method, body: {} }), /Read-only/);
  }
  await assert.rejects(forge.status(snapshot, 'success', 'forbidden'), /Read-only/);
  assert.equal(calls.length, 1, 'no mutation reaches the network');
  assert.throws(() => createForge({ readToken: 'actions-read-only' }), /Separate/);
});
