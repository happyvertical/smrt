import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ADMITTED_GROUPS,
  createReleaseAdmissionState,
  transitionReleaseAdmission as transition,
  updateReleaseAdmissionState,
  validateReleaseAdmissionState,
  validateReleaseRecoveryArtifacts,
} from './release-admission-state.mjs';

const repository = 'happyvertical/smrt';
const owner = { runId: 40099394984, runAttempt: 1 };
const group = 'a'.repeat(40);
const snapshot = 'b'.repeat(40);
const replacement = 'c'.repeat(40);
const releaseCommit = 'd'.repeat(40);
const recoveryArtifacts = [
  { id: 101, name: 'release-git-bundle-1', digest: `sha256:${'1'.repeat(64)}` },
  { id: 102, name: 'release-pack-shard-1', digest: `sha256:${'2'.repeat(64)}` },
  { id: 103, name: 'release-pack-shard-2', digest: `sha256:${'3'.repeat(64)}` },
];
const release = { snapshotSha: snapshot, releaseCommitSha: releaseCommit, version: '0.57.27', ref: 'refs/tags/v0.57.27', recoveryArtifacts };
const main = { authenticated: true, repository, protected: true, ref: 'refs/heads/main', sha: snapshot };
const qualification = { authenticated: true, repository, success: true, snapshotSha: snapshot };
const close = { type: 'close', owner, nowMs: 100, timeoutMs: 1000 };
const freeze = { type: 'freeze', owner, nowMs: 200, main };
const publish = { type: 'beginPublishing', owner, nowMs: 300, release, qualification };
const complete = {
  type: 'complete', owner, release,
  evidence: {
    authenticated: true, repository, ...release, refSha: releaseCommit, sourceParentSha: snapshot,
    registries: { primary: 'success' },
  },
};
const observe = (sha = group, disposition = 'merged', refExists = false) => ({
  type: 'observeGroup', owner,
  facts: { authenticated: true, repository, sha, disposition, refExists },
});

function draining() {
  const admitted = transition(createReleaseAdmissionState({ repository }), { type: 'admit', sha: group });
  return transition(admitted, close);
}

function qualifying() {
  return transition(transition(draining(), observe()), freeze);
}

function rejects(state, operation, code) {
  assert.throws(() => transition(state, operation), (error) => error.code === code);
}

test('finite admitted snapshot drains, qualifies, publishes and reopens only after exact registry evidence', () => {
  let state = draining();
  state = transition(state, observe());
  state = transition(state, freeze);
  assert.equal(state.snapshotSha, snapshot);
  assert.equal(state.phase, 'qualifying');
  state = transition(state, publish);
  assert.equal(state.phase, 'publishing');
  const result = transition(state, complete);
  assert.equal(result.phase, 'open');
  assert.deepEqual(result.lastRelease, release);
  assert.equal(result.owner, null);
  assert.deepEqual(result.admitted, []);
  assert.equal(state.phase, 'publishing', 'pure transition must not mutate its input');
});

test('new arrivals and replacement merge-group SHAs require admission after reopening', () => {
  const state = draining();
  assert.equal(transition(state, { type: 'admit', sha: group }), state);
  rejects(state, { type: 'admit', sha: replacement }, 'admission-closed');
  rejects(state, observe(replacement), 'group-not-admitted');
  const open = transition(state, { type: 'abort', owner });
  const admitted = transition(open, { type: 'admit', sha: replacement });
  assert.deepEqual(admitted.admitted.map((entry) => entry.sha), [group, replacement]);
});

test('successful completed group with a live queue ref is still not drained', () => {
  const state = draining();
  const live = observe(group, 'merged', true);
  live.facts.status = 'completed';
  live.facts.conclusion = 'success';
  assert.equal(transition(state, live), state);
  rejects(state, freeze, 'groups-not-drained');
  const deleted = transition(state, observe(group, 'deleted'));
  assert.equal(transition(deleted, freeze).phase, 'qualifying');
  const reappeared = transition(deleted, live);
  assert.equal(reappeared.admitted[0].disposition, 'pending');
  rejects(reappeared, freeze, 'groups-not-drained');
});

test('group disposition requires separate authenticated exact-repository facts', () => {
  const state = draining();
  for (const patch of [{ authenticated: false }, { repository: 'fork/smrt' }]) {
    const operation = observe();
    Object.assign(operation.facts, patch);
    rejects(state, operation, 'authenticated-facts-required');
  }
  rejects(state, { ...observe(), facts: { ...observe().facts, refExists: undefined } }, 'invalid-group-facts');
  rejects(state, observe(group, 'success'), 'unresolved-group');
  const resolved = transition(state, observe());
  rejects(resolved, observe(group, 'deleted'), 'group-disposition-conflict');
});

test('every admitted group must resolve before exact protected-main freezing', () => {
  let state = transition(createReleaseAdmissionState({ repository }), { type: 'admit', sha: group });
  state = transition(state, { type: 'admit', sha: replacement });
  state = transition(state, close);
  state = transition(state, observe());
  rejects(state, freeze, 'groups-not-drained');
  state = transition(state, observe(replacement, 'deleted'));
  for (const patch of [{ authenticated: false }, { protected: false }, { ref: 'refs/heads/feature' }, { sha: 'bad' }]) {
    assert.throws(() => transition(state, { ...freeze, main: { ...main, ...patch } }));
  }
  assert.equal(transition(state, freeze).snapshotSha, snapshot);
});

test('owner attempt and stale state revision guard transitions', () => {
  const state = draining();
  for (const wrong of [{ runId: 1, runAttempt: 1 }, { ...owner, runAttempt: 2 }]) {
    rejects(state, { ...observe(), owner: wrong }, 'owner-mismatch');
    rejects(state, { ...close, owner: wrong }, 'owner-mismatch');
    rejects(state, { type: 'abort', owner: wrong }, 'owner-mismatch');
  }
  rejects(state, { ...observe(), expectedRevision: state.revision - 1 }, 'stale-revision');
});

test('identical repeated operations are idempotent without revision increments', () => {
  let state = draining();
  assert.equal(transition(state, close), state);
  state = transition(state, observe());
  assert.equal(transition(state, observe()), state);
  state = transition(state, freeze);
  assert.equal(transition(state, freeze), state);
  assert.equal(transition(state, observe()), state);
  state = transition(state, publish);
  assert.equal(transition(state, publish), state);
  state = transition(state, complete);
  assert.equal(transition(state, complete), state);
  const aborted = transition(draining(), { type: 'abort', owner });
  assert.equal(transition(aborted, { type: 'abort', owner }), aborted);
});

test('bounded timeout before publication can reopen while retaining unresolved admissions', () => {
  const state = draining();
  rejects(state, { type: 'timeout', owner, nowMs: 1099 }, 'window-not-expired');
  rejects(state, { ...freeze, nowMs: 1100 }, 'window-expired');
  const timeout = { type: 'timeout', owner, nowMs: 1100 };
  const reopened = transition(state, timeout);
  assert.equal(reopened.phase, 'open');
  assert.deepEqual(reopened.admitted, [{ sha: group, disposition: 'pending', grant: null }]);
  assert.equal(transition(reopened, timeout), reopened);
  assert.equal(transition(qualifying(), { type: 'abort', owner }).phase, 'open');
  rejects(qualifying(), { ...publish, nowMs: 1100 }, 'window-expired');
});

test('partial publication must remain recovery until all exact release evidence succeeds', () => {
  const publishing = transition(qualifying(), publish);
  let state = transition(publishing, { type: 'timeout', owner, nowMs: 1100 });
  assert.equal(state.phase, 'recovery');
  assert.equal(transition(state, { type: 'abort', owner }), state);
  assert.equal(transition(state, { type: 'timeout', owner, nowMs: 5000 }), state);
  rejects(state, { type: 'admit', sha: replacement }, 'admission-closed');
  rejects(state, { ...close, owner: { ...owner, runAttempt: 2 } }, 'owner-mismatch');
  for (const registry of ['primary']) {
    const partial = structuredClone(complete);
    partial.evidence.registries[registry] = 'failure';
    rejects(state, partial, 'registry-evidence-incomplete');
  }
  assert.equal(transition(state, complete).phase, 'open');
});

test('qualification and completion evidence cannot silently select a different source or release', () => {
  const state = qualifying();
  rejects(state, { ...publish, qualification: { ...qualification, success: false } }, 'qualification-required');
  rejects(state, { ...publish, qualification: { ...qualification, snapshotSha: group } }, 'qualification-required');
  rejects(state, { ...publish, qualification: { ...qualification, authenticated: false } }, 'authenticated-facts-required');
  const publishing = transition(state, publish);
  for (const patch of [{ snapshotSha: group }, { version: '0.57.28' }, { ref: 'refs/tags/v0.57.28' }, { refSha: group }, { sourceParentSha: group }, { releaseCommitSha: group }]) {
    rejects(publishing, { ...complete, evidence: { ...complete.evidence, ...patch } }, 'release-evidence-mismatch');
  }
  const other = { ...release, version: '0.57.28', ref: 'refs/tags/v0.57.28' };
  rejects(publishing, { ...publish, release: other }, 'release-mismatch');
  rejects(publishing, { ...complete, release: other, evidence: { ...complete.evidence, ...other } }, 'release-mismatch');
  rejects(state, { ...publish, release: { ...release, releaseCommitSha: snapshot } }, 'release-mismatch');
});

test('primary registry gates reopening while callers may explicitly require a mirror', () => {
  const publishing = transition(qualifying(), publish);
  assert.equal(transition(publishing, complete).phase, 'open');
  const withMirror = { ...publishing, requiredRegistries: ['primary', 'npmjs'] };
  rejects(withMirror, complete, 'registry-evidence-incomplete');
  assert.equal(transition(withMirror, {
    ...complete,
    evidence: { ...complete.evidence, registries: { primary: 'success', npmjs: 'success' } },
  }).phase, 'open');
});

test('recovery artifact bindings are canonical, detached and retained through recovery/completion', () => {
  const reversed = structuredClone(recoveryArtifacts).reverse();
  assert.deepEqual(validateReleaseRecoveryArtifacts(reversed), recoveryArtifacts);
  const publishing = transition(qualifying(), {
    ...publish, release: { ...release, recoveryArtifacts: reversed },
  });
  assert.deepEqual(publishing.release.recoveryArtifacts, recoveryArtifacts);
  reversed[0].name = 'mutated-after-transition';
  assert.deepEqual(publishing.release.recoveryArtifacts, recoveryArtifacts);
  assert.equal(transition(publishing, publish), publishing);
  const recovery = transition(publishing, { type: 'abort', owner });
  assert.deepEqual(recovery.release.recoveryArtifacts, recoveryArtifacts);
  assert.deepEqual(transition(recovery, complete).lastRelease.recoveryArtifacts, recoveryArtifacts);
});

test('malformed or missing recovery inventory cannot enter publishing', () => {
  const invalid = [
    undefined, [], recoveryArtifacts.slice(0, 1),
    [{ ...recoveryArtifacts[0] }, { ...recoveryArtifacts[1], id: recoveryArtifacts[0].id }],
    [{ ...recoveryArtifacts[0] }, { ...recoveryArtifacts[1], name: recoveryArtifacts[0].name }],
    [{ ...recoveryArtifacts[0], id: 0 }, recoveryArtifacts[1]],
    [{ ...recoveryArtifacts[0], id: 1.5 }, recoveryArtifacts[1]],
    [{ ...recoveryArtifacts[0], id: Number.MAX_SAFE_INTEGER + 1 }, recoveryArtifacts[1]],
    [{ ...recoveryArtifacts[0], name: ' ' }, recoveryArtifacts[1]],
    [{ ...recoveryArtifacts[0], digest: 'unknown' }, recoveryArtifacts[1]],
    [{ ...recoveryArtifacts[0], digest: `sha256:${'F'.repeat(64)}` }, recoveryArtifacts[1]],
    [{ ...recoveryArtifacts[0], extra: true }, recoveryArtifacts[1]],
  ];
  for (const inventory of invalid) {
    assert.throws(() => validateReleaseRecoveryArtifacts(inventory));
    rejects(qualifying(), { ...publish, release: { ...release, recoveryArtifacts: inventory } }, 'release-mismatch');
  }
  const missing = structuredClone(release);
  delete missing.recoveryArtifacts;
  rejects(qualifying(), { ...publish, release: missing }, 'release-mismatch');
});

test('changed or incomplete recovery bindings cannot replace an irreversible release', () => {
  const publishing = transition(qualifying(), publish);
  for (const mutate of [
    (artifacts) => { artifacts[0].id = 999; },
    (artifacts) => { artifacts[0].name = 'different-bundle'; },
    (artifacts) => { artifacts[0].digest = `sha256:${'f'.repeat(64)}`; },
    (artifacts) => { artifacts.pop(); },
  ]) {
    const changed = structuredClone(recoveryArtifacts);
    mutate(changed);
    const other = { ...release, recoveryArtifacts: changed };
    rejects(publishing, { ...publish, release: other }, 'release-mismatch');
    rejects(publishing, { ...complete, evidence: { ...complete.evidence, recoveryArtifacts: changed } }, 'recovery-artifact-evidence-mismatch');
    rejects(publishing, { ...complete, release: other, evidence: { ...complete.evidence, recoveryArtifacts: changed } }, 'release-mismatch');
    const recovery = transition(publishing, { type: 'abort', owner });
    rejects(recovery, { ...publish, release: other }, 'release-mismatch');
  }
  const missing = structuredClone(complete);
  delete missing.evidence.recoveryArtifacts;
  rejects(publishing, missing, 'recovery-artifact-evidence-mismatch');
});

test('state bounds reject malformed SHA, invalid schema, duplicate admission and unbounded windows', () => {
  let state = createReleaseAdmissionState({ repository });
  for (const invalid of ['short', 'a'.repeat(41), 'A'.repeat(40), null]) {
    rejects(state, { type: 'admit', sha: invalid }, 'invalid-group-sha');
  }
  for (let index = 0; index < MAX_ADMITTED_GROUPS; index++) {
    state = transition(state, { type: 'admit', sha: index.toString(16).padStart(40, '0') });
  }
  rejects(state, { type: 'admit', sha: group }, 'admission-capacity');
  rejects(state, { ...close, timeoutMs: Infinity }, 'invalid-window');
  rejects(state, { ...close, timeoutMs: 86_400_001 }, 'invalid-window');
  assert.throws(() => validateReleaseAdmissionState({ ...state, schemaVersion: 2 }));
  assert.throws(() => validateReleaseAdmissionState({ ...state, admitted: [...state.admitted, state.admitted[0]] }));
  assert.throws(() => validateReleaseAdmissionState({ ...state, phase: 'publishing' }));
});

function memoryStore(initial) {
  let head = { revision: 'backend-0', state: initial };
  return {
    read: async () => structuredClone(head),
    compareAndSwap: async (revision, state) => {
      if (revision !== head.revision) return false;
      head = { revision: `backend-${state.revision}`, state: structuredClone(state) };
      return true;
    },
  };
}

test('racing admissions retry refreshed state without losing either exact SHA', async () => {
  const store = memoryStore(createReleaseAdmissionState({ repository }));
  await Promise.all([group, replacement].map((sha) =>
    updateReleaseAdmissionState(store, (state) => transition(state, { type: 'admit', sha }))));
  const head = await store.read();
  assert.equal(head.state.revision, 2);
  assert.deepEqual(new Set(head.state.admitted.map((entry) => entry.sha)), new Set([group, replacement]));
});

test('close versus late admission race cannot overwrite the frozen admitted list', async () => {
  const store = memoryStore(createReleaseAdmissionState({ repository }));
  const results = await Promise.allSettled([
    updateReleaseAdmissionState(store, (state) => transition(state, close)),
    updateReleaseAdmissionState(store, (state) => transition(state, { type: 'admit', sha: replacement })),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'admission-closed');
  assert.deepEqual((await store.read()).state.admitted, []);
});

test('a close that loses the CAS race refreshes and retains the newly admitted SHA', async () => {
  const store = memoryStore(createReleaseAdmissionState({ repository }));
  await Promise.all([
    updateReleaseAdmissionState(store, (state) => transition(state, { type: 'admit', sha: replacement })),
    updateReleaseAdmissionState(store, (state) => transition(state, close)),
  ]);
  const state = (await store.read()).state;
  assert.equal(state.phase, 'draining');
  assert.deepEqual(state.admitted, [{ sha: replacement, disposition: 'pending', grant: null }]);
});

test('CAS conflicts are bounded and missing state is never initialized implicitly', async () => {
  let reads = 0;
  let writes = 0;
  const state = createReleaseAdmissionState({ repository });
  const conflicted = {
    read: async () => { reads++; return { revision: `ref-${reads}`, state }; },
    compareAndSwap: async () => { writes++; return false; },
  };
  await assert.rejects(updateReleaseAdmissionState(conflicted, (s) => transition(s, close), { maxAttempts: 2 }),
    (error) => error.code === 'compare-and-swap-conflict');
  assert.equal(reads, 2);
  assert.equal(writes, 2);
  await assert.rejects(updateReleaseAdmissionState({ read: async () => null }, (s) => s),
    (error) => error.code === 'missing-store-head');
});

test('a resolved known SHA is not idempotently readmitted inside a closed window', () => {
  let state = draining();
  assert.equal(transition(state, { type: 'admit', sha: group }), state);
  state = transition(state, observe(group, 'deleted'));
  rejects(state, { type: 'admit', sha: group }, 'admission-closed');
  state = transition(state, freeze);
  rejects(state, { type: 'admit', sha: group }, 'admission-closed');
  state = transition(state, publish);
  rejects(state, { type: 'admit', sha: group }, 'admission-closed');
  state = transition(state, { type: 'abort', owner });
  rejects(state, { type: 'admit', sha: group }, 'admission-closed');
});

test('status grant reservation is exclusive, owner-bound and blocks resolution until acknowledged', () => {
  const grant = { id: 'a'.repeat(32), runId: 100, runAttempt: 1, validationRunId: 200 };
  let state = transition(createReleaseAdmissionState({ repository }), { type: 'reserveGrant', sha: group, grant });
  assert.deepEqual(state.admitted[0].grant, grant);
  rejects(state, { type: 'reserveGrant', sha: group, grant: { ...grant, id: 'b'.repeat(32) } }, 'status-grant-unsettled');
  state = transition(state, close);
  rejects(state, observe(), 'status-grant-unsettled');
  rejects(state, freeze, 'groups-not-drained');
  rejects(state, { type: 'finishGrant', sha: group, grant: { ...grant, runAttempt: 2 } }, 'status-grant-owner-mismatch');
  state = transition(state, { type: 'finishGrant', sha: group, grant });
  state = transition(state, observe());
  assert.equal(transition(state, freeze).phase, 'qualifying');
});
