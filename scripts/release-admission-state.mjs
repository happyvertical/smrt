/**
 * Release admission protocol only. authenticated facts must be obtained by the
 * caller through an independently trusted forge/registry channel; a field in
 * check-result JSON is not authentication. Runtime use additionally requires
 * protected admission refs and trusted credentials, reviewed separately.
 */
import { isDeepStrictEqual as same } from 'node:util';

export const MAX_ADMITTED_GROUPS = 128;
const MAX_WINDOW_MS = 86_400_000;
const phases = ['open', 'draining', 'qualifying', 'publishing', 'recovery'];
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class ReleaseAdmissionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReleaseAdmissionError';
    this.code = code;
  }
}

function requireFact(condition, code) {
  if (!condition) throw new ReleaseAdmissionError(code);
}

function validOwner(owner) {
  return plain(owner) && Number.isSafeInteger(owner.runId) && owner.runId > 0 &&
    Number.isSafeInteger(owner.runAttempt) && owner.runAttempt > 0 &&
    Object.keys(owner).length === 2;
}

function validGrant(grant) {
  return grant === null || (plain(grant) && Object.keys(grant).length === 4 &&
    typeof grant.id === 'string' && /^[a-f0-9]{32}$/.test(grant.id) &&
    Number.isSafeInteger(grant.runId) && grant.runId > 0 &&
    Number.isSafeInteger(grant.runAttempt) && grant.runAttempt > 0 &&
    Number.isSafeInteger(grant.validationRunId) && grant.validationRunId > 0);
}

function validRecoveryArtifacts(artifacts) {
  return Array.isArray(artifacts) && artifacts.length >= 2 && artifacts.length <= 64 &&
    artifacts.every((artifact) => plain(artifact) && Object.keys(artifact).length === 3 &&
      Number.isSafeInteger(artifact.id) && artifact.id > 0 &&
      typeof artifact.name === 'string' && artifact.name.trim().length > 0 && artifact.name.length <= 200 &&
      typeof artifact.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(artifact.digest)) &&
    new Set(artifacts.map((artifact) => artifact.id)).size === artifacts.length &&
    new Set(artifacts.map((artifact) => artifact.name)).size === artifacts.length;
}

/** Syntax/bounds only; callers independently authenticate run/attempt inventory. */
export function validateReleaseRecoveryArtifacts(artifacts) {
  requireFact(validRecoveryArtifacts(artifacts), 'invalid-recovery-artifacts');
  return artifacts.map((artifact) => ({ id: artifact.id, name: artifact.name, digest: artifact.digest }))
    .sort((left, right) => left.id - right.id);
}

function validRelease(release) {
  return plain(release) && Object.keys(release).length === 5 && sha(release.snapshotSha) && sha(release.releaseCommitSha) &&
    release.releaseCommitSha !== release.snapshotSha &&
    validRecoveryArtifacts(release.recoveryArtifacts) &&
    typeof release.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version) &&
    release.ref === `refs/tags/v${release.version}`;
}

function canonicalRelease(release) {
  return {
    snapshotSha: release.snapshotSha, releaseCommitSha: release.releaseCommitSha,
    version: release.version, ref: release.ref,
    recoveryArtifacts: validateReleaseRecoveryArtifacts(release.recoveryArtifacts),
  };
}

export function validateReleaseAdmissionState(state) {
  requireFact(plain(state), 'invalid-state');
  const fields = [
    'schemaVersion', 'revision', 'repository', 'mainRef', 'requiredRegistries',
    'phase', 'admitted', 'owner', 'deadlineMs', 'snapshotSha', 'release', 'lastRelease', 'lastWindow',
  ];
  requireFact(Object.keys(state).length === fields.length && fields.every((key) => Object.hasOwn(state, key)), 'invalid-state-fields');
  requireFact(state.schemaVersion === 1 && integer(state.revision), 'invalid-state-version');
  requireFact(typeof state.repository === 'string' && state.repository.length <= 200 && /^[^/\s]+\/[^/\s]+$/.test(state.repository), 'invalid-repository');
  requireFact(typeof state.mainRef === 'string' && /^refs\/heads\/[A-Za-z0-9_/-]+$/.test(state.mainRef) && state.mainRef.length <= 200, 'invalid-main-ref');
  requireFact(Array.isArray(state.requiredRegistries) && state.requiredRegistries.length > 0 && state.requiredRegistries.length <= 8 &&
    state.requiredRegistries.every((name) => typeof name === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(name)) &&
    new Set(state.requiredRegistries).size === state.requiredRegistries.length, 'invalid-registries');
  requireFact(phases.includes(state.phase), 'invalid-phase');
  requireFact(Array.isArray(state.admitted) && state.admitted.length <= MAX_ADMITTED_GROUPS, 'invalid-admitted-list');
  requireFact(state.admitted.every((group) => plain(group) && Object.keys(group).length === 3 && sha(group.sha) && validGrant(group.grant) &&
    (group.disposition === 'pending' || group.grant === null) &&
    ['pending', 'merged', 'deleted'].includes(group.disposition)) &&
    new Set(state.admitted.map((group) => group.sha)).size === state.admitted.length, 'invalid-admitted-group');
  requireFact(state.lastRelease === null || validRelease(state.lastRelease), 'invalid-last-release');
  requireFact(state.lastWindow === null || (plain(state.lastWindow) && Object.keys(state.lastWindow).length === 3 &&
    validOwner(state.lastWindow.owner) && integer(state.lastWindow.deadlineMs) &&
    ['aborted', 'completed'].includes(state.lastWindow.outcome)), 'invalid-last-window');
  if (state.phase === 'open') {
    requireFact(state.owner === null && state.deadlineMs === null && state.snapshotSha === null && state.release === null &&
      state.admitted.every((group) => group.disposition === 'pending'), 'invalid-open-state');
  } else {
    requireFact(validOwner(state.owner) && integer(state.deadlineMs), 'invalid-owned-state');
    if (state.phase === 'draining') {
      requireFact(state.snapshotSha === null && state.release === null, 'invalid-draining-state');
    } else {
      requireFact(sha(state.snapshotSha) && state.admitted.every((group) => group.disposition !== 'pending'), 'invalid-frozen-state');
      requireFact(state.phase === 'qualifying' ? state.release === null : validRelease(state.release) && state.release.snapshotSha === state.snapshotSha, 'invalid-release-state');
    }
  }
  requireFact(JSON.stringify(state).length <= 32_768, 'state-size-limit');
  return state;
}

// Primary publication gates reopening; mirrors are independent unless callers
// explicitly include them in requiredRegistries.
export function createReleaseAdmissionState({ repository, mainRef = 'refs/heads/main', requiredRegistries = ['primary'] } = {}) {
  return validateReleaseAdmissionState({
    schemaVersion: 1, revision: 0, repository, mainRef,
    requiredRegistries: [...requiredRegistries], phase: 'open', admitted: [],
    owner: null, deadlineMs: null, snapshotSha: null, release: null, lastRelease: null, lastWindow: null,
  });
}

function authentic(state, facts) {
  requireFact(plain(facts) && facts.authenticated === true && facts.repository === state.repository, 'authenticated-facts-required');
}

function reopen(state, outcome = 'aborted') {
  return {
    ...state, phase: 'open', admitted: state.admitted.filter((group) => group.disposition === 'pending'),
    owner: null, deadlineMs: null, snapshotSha: null, release: null,
    lastWindow: { owner: state.owner, deadlineMs: state.deadlineMs, outcome },
  };
}

/**
 * Operations use {type, owner?, nowMs?, ...}; non-open operations require the
 * exact owner run/attempt. expectedRevision optionally detects stale commands.
 * Repeated identical operations return the original state without a revision.
 */
export function transitionReleaseAdmission(state, operation) {
  validateReleaseAdmissionState(state);
  requireFact(plain(operation) && typeof operation.type === 'string', 'invalid-operation');
  if (Object.hasOwn(operation, 'expectedRevision')) {
    requireFact(operation.expectedRevision === state.revision, 'stale-revision');
  }
  let next = structuredClone(state);
  const owned = () => requireFact(validOwner(operation.owner) && same(operation.owner, state.owner), 'owner-mismatch');
  const timely = () => requireFact(integer(operation.nowMs) && operation.nowMs < state.deadlineMs, 'window-expired');
  switch (operation.type) {
    case 'admit': {
      requireFact(sha(operation.sha), 'invalid-group-sha');
      const existing = state.admitted.find((group) => group.sha === operation.sha);
      if (existing) {
        requireFact(state.phase === 'open' || (state.phase === 'draining' && existing.disposition === 'pending'), 'admission-closed');
        return state;
      }
      requireFact(state.phase === 'open', 'admission-closed');
      requireFact(state.admitted.length < MAX_ADMITTED_GROUPS, 'admission-capacity');
      next.admitted.push({ sha: operation.sha, disposition: 'pending', grant: null });
      break;
    }
    case 'reserveGrant': {
      requireFact(sha(operation.sha) && operation.grant !== null && validGrant(operation.grant), 'invalid-status-grant');
      requireFact(state.phase === 'open', 'admission-closed');
      let group = next.admitted.find((entry) => entry.sha === operation.sha);
      if (!group) {
        requireFact(state.admitted.length < MAX_ADMITTED_GROUPS, 'admission-capacity');
        group = { sha: operation.sha, disposition: 'pending', grant: null };
        next.admitted.push(group);
      }
      requireFact(group.disposition === 'pending', 'admission-closed');
      requireFact(group.grant === null || same(group.grant, operation.grant), 'status-grant-unsettled');
      group.grant = { ...operation.grant };
      break;
    }
    case 'finishGrant': {
      requireFact(sha(operation.sha) && operation.grant !== null && validGrant(operation.grant), 'invalid-status-grant');
      const group = next.admitted.find((entry) => entry.sha === operation.sha);
      requireFact(group && group.disposition === 'pending' && same(group.grant, operation.grant), 'status-grant-owner-mismatch');
      group.grant = null;
      break;
    }
    case 'close': {
      requireFact(validOwner(operation.owner), 'invalid-owner');
      if (state.phase !== 'open') {
        owned();
        return state;
      }
      requireFact(integer(operation.nowMs) && integer(operation.timeoutMs) && operation.timeoutMs > 0 &&
        operation.timeoutMs <= MAX_WINDOW_MS && integer(operation.nowMs + operation.timeoutMs), 'invalid-window');
      next.phase = 'draining';
      next.owner = { runId: operation.owner.runId, runAttempt: operation.owner.runAttempt };
      next.deadlineMs = operation.nowMs + operation.timeoutMs;
      break;
    }
    case 'observeGroup': {
      requireFact(state.phase !== 'open', 'not-draining');
      owned();
      const facts = operation.facts;
      authentic(state, facts);
      requireFact(sha(facts.sha) && typeof facts.refExists === 'boolean', 'invalid-group-facts');
      const group = next.admitted.find((entry) => entry.sha === facts.sha);
      requireFact(group, 'group-not-admitted');
      // A completed successful check is insufficient while its queue ref lives.
      if (facts.refExists) {
        requireFact(state.phase === 'draining', 'groups-already-frozen');
        group.disposition = 'pending';
        break;
      }
      requireFact(group.grant === null, 'status-grant-unsettled');
      requireFact(['merged', 'deleted'].includes(facts.disposition), 'unresolved-group');
      requireFact(group.disposition === 'pending' || group.disposition === facts.disposition, 'group-disposition-conflict');
      group.disposition = facts.disposition;
      break;
    }
    case 'freeze': {
      owned();
      authentic(state, operation.main);
      requireFact(operation.main.protected === true && operation.main.ref === state.mainRef && sha(operation.main.sha), 'protected-main-required');
      if (state.phase !== 'draining') {
        requireFact(state.snapshotSha === operation.main.sha, 'snapshot-mismatch');
        return state;
      }
      timely();
      requireFact(state.admitted.every((group) => group.disposition !== 'pending'), 'groups-not-drained');
      next.snapshotSha = operation.main.sha;
      next.phase = 'qualifying';
      break;
    }
    case 'beginPublishing': {
      owned();
      requireFact(validRelease(operation.release) && operation.release.snapshotSha === state.snapshotSha, 'release-mismatch');
      if (['publishing', 'recovery'].includes(state.phase)) {
        requireFact(same(canonicalRelease(state.release), canonicalRelease(operation.release)), 'release-mismatch');
        return state;
      }
      requireFact(state.phase === 'qualifying', 'not-qualifying');
      timely();
      authentic(state, operation.qualification);
      requireFact(operation.qualification.success === true && operation.qualification.snapshotSha === state.snapshotSha, 'qualification-required');
      next.release = canonicalRelease(operation.release);
      next.phase = 'publishing';
      break;
    }
    case 'abort':
    case 'timeout': {
      if (state.phase === 'open') {
        requireFact(state.lastWindow?.outcome === 'aborted' && same(state.lastWindow.owner, operation.owner), 'owner-mismatch');
        if (operation.type === 'timeout') requireFact(integer(operation.nowMs) && operation.nowMs >= state.lastWindow.deadlineMs, 'window-not-expired');
        return state;
      }
      owned();
      if (operation.type === 'timeout') requireFact(integer(operation.nowMs) && operation.nowMs >= state.deadlineMs, 'window-not-expired');
      next = ['publishing', 'recovery'].includes(state.phase) ? { ...next, phase: 'recovery' } : reopen(next);
      break;
    }
    case 'complete': {
      requireFact(validRelease(operation.release), 'invalid-release');
      const release = canonicalRelease(operation.release);
      authentic(state, operation.evidence);
      const evidence = operation.evidence;
      requireFact(evidence.snapshotSha === release.snapshotSha && evidence.version === release.version &&
        evidence.ref === release.ref && evidence.refSha === release.releaseCommitSha &&
        evidence.releaseCommitSha === release.releaseCommitSha && evidence.sourceParentSha === release.snapshotSha, 'release-evidence-mismatch');
      requireFact(validRecoveryArtifacts(evidence.recoveryArtifacts) &&
        same(validateReleaseRecoveryArtifacts(evidence.recoveryArtifacts), release.recoveryArtifacts), 'recovery-artifact-evidence-mismatch');
      requireFact(plain(evidence.registries) && state.requiredRegistries.every((name) => evidence.registries[name] === 'success'), 'registry-evidence-incomplete');
      if (state.phase === 'open') {
        requireFact(same(state.lastRelease, release) && state.lastWindow?.outcome === 'completed' &&
          same(state.lastWindow.owner, operation.owner), 'release-mismatch');
        return state;
      }
      owned();
      requireFact(['publishing', 'recovery'].includes(state.phase) && same(state.release, release), 'release-mismatch');
      next = { ...reopen(next, 'completed'), lastRelease: release };
      break;
    }
    default:
      throw new ReleaseAdmissionError('unknown-operation');
  }
  if (same(next, state)) return state;
  next.revision = state.revision + 1;
  return validateReleaseAdmissionState(next);
}

/** Retry against refreshed backend revisions. Missing state never initializes. */
export async function updateReleaseAdmissionState(store, transition, { maxAttempts = 5 } = {}) {
  requireFact(Number.isSafeInteger(maxAttempts) && maxAttempts > 0 && maxAttempts <= 100, 'invalid-retry-limit');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const head = await store.read();
    requireFact(plain(head) && head.revision !== undefined && head.revision !== null, 'missing-store-head');
    validateReleaseAdmissionState(head.state);
    const next = transition(structuredClone(head.state));
    validateReleaseAdmissionState(next);
    if (same(next, head.state)) return head.state;
    requireFact(next.revision === head.state.revision + 1, 'invalid-transition-revision');
    const swapped = await store.compareAndSwap(head.revision, next);
    requireFact(typeof swapped === 'boolean', 'invalid-compare-and-swap-result');
    if (swapped) return next;
  }
  throw new ReleaseAdmissionError('compare-and-swap-conflict');
}
