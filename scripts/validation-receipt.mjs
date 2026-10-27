/**
 * Content identity for a validation result, not an authorization token.
 *
 * Callers must obtain authenticatedProducer independently from their forge or
 * attestation verifier, never from the receipt or a PR-controlled artifact.
 * Artifact hashes in expectedIdentity must come from the actual candidate
 * bytes. External inputs must be fully enumerated and content-addressable;
 * this cannot authorize reuse of a Planner run against unknown mutable data.
 */
import { createHash } from 'node:crypto';

export const VALIDATION_RECEIPT_SCHEMA_VERSION = 1;

const digest = /^[a-f0-9]{64}$/;
const gitObject = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const isDigest = (value) => typeof value === 'string' && digest.test(value);
const isGitObject = (value) => typeof value === 'string' && gitObject.test(value);
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;

function fields(value, names, path, reasons) {
  if (!object(value)) {
    reasons.push(`${path}: expected object`);
    return false;
  }
  if (
    names.some((name) => !Object.hasOwn(value, name)) ||
    Object.keys(value).some((name) => !names.includes(name))
  ) {
    reasons.push(`${path}: missing or unknown fields`);
    return false;
  }
  return true;
}

function inventory(value, path, reasons, { hashes = false, nonempty = false } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) {
    reasons.push(`${path}: expected ${nonempty ? 'nonempty ' : ''}array`);
    return;
  }
  const names = new Set();
  for (const entry of value) {
    if (hashes && !fields(entry, ['name', 'sha256'], path, reasons)) continue;
    const name = hashes ? entry.name : entry;
    if (!text(name) || names.has(name)) {
      reasons.push(`${path}: empty or duplicate name`);
    }
    names.add(name);
    if (hashes && !isDigest(entry.sha256)) {
      reasons.push(`${path}: unknown or invalid sha256`);
    }
  }
}

function identityReasons(identity) {
  const reasons = [];
  if (!fields(identity, [
    'source', 'lockSha256', 'toolchain', 'inputs', 'comparisonBase',
    'selectedSuites', 'artifacts', 'externalInputs',
  ], 'identity', reasons)) return reasons;
  if (fields(identity.source, ['repository', 'commit', 'tree'], 'identity.source', reasons)) {
    if (!text(identity.source.repository) || !/^[^/\s]+\/[^/\s]+$/.test(identity.source.repository)) {
      reasons.push('identity.source.repository: expected owner/repository');
    }
    for (const field of ['commit', 'tree']) {
      if (!isGitObject(identity.source[field])) reasons.push(`identity.source.${field}: invalid Git object`);
    }
  }
  if (!isDigest(identity.lockSha256)) reasons.push('identity.lockSha256: invalid sha256');
  if (fields(identity.toolchain, ['node', 'pnpm', 'platform'], 'identity.toolchain', reasons)) {
    for (const field of ['node', 'pnpm']) {
      if (typeof identity.toolchain[field] !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(identity.toolchain[field])) {
        reasons.push(`identity.toolchain.${field}: expected exact version`);
      }
    }
    if (!text(identity.toolchain.platform)) reasons.push('identity.toolchain.platform: missing platform');
  }
  if (fields(identity.inputs, ['workflowSha256', 'validatorSha256'], 'identity.inputs', reasons)) {
    for (const field of ['workflowSha256', 'validatorSha256']) {
      if (!isDigest(identity.inputs[field])) reasons.push(`identity.inputs.${field}: invalid sha256`);
    }
  }
  if (!isGitObject(identity.comparisonBase)) reasons.push('identity.comparisonBase: invalid Git object');
  inventory(identity.selectedSuites, 'identity.selectedSuites', reasons, { nonempty: true });
  inventory(identity.artifacts, 'identity.artifacts', reasons, { hashes: true, nonempty: true });
  inventory(identity.externalInputs, 'identity.externalInputs', reasons, { hashes: true });
  return reasons;
}

function producerReasons(producer) {
  const reasons = [];
  if (!fields(producer, ['workflow', 'runId', 'runAttempt'], 'producer', reasons)) return reasons;
  if (!text(producer.workflow)) reasons.push('producer.workflow: missing workflow');
  for (const field of ['runId', 'runAttempt']) {
    if (!Number.isSafeInteger(producer[field]) || producer[field] <= 0) {
      reasons.push(`producer.${field}: expected positive safe integer`);
    }
  }
  return reasons;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** Create a detached, deterministic JSON value. Invalid identities throw. */
export function createValidationReceipt({ identity, producer } = {}) {
  const reasons = [...identityReasons(identity), ...producerReasons(producer)];
  if (reasons.length) throw new TypeError(reasons.join('; '));
  return canonical({ schemaVersion: VALIDATION_RECEIPT_SCHEMA_VERSION, identity, producer });
}

/** Digest to bind through separately authenticated artifact/attestation facts. */
export function validationReceiptSha256(receipt) {
  return createHash('sha256').update(JSON.stringify(canonical(receipt))).digest('hex');
}

/**
 * Fail closed. expectedProducer is a separately chosen repository, workflow,
 * runId and runAttempt; authenticatedProducer is independently verified forge
 * evidence, including receiptSha256 from its authenticated artifact binding.
 * trustedRef means the caller verified its protected-ref policy.
 * No receipt field or environment variable can turn off these requirements.
 */
export function verifyValidationReceipt(receipt, options = {}) {
  const reasons = [];
  if (!object(options)) return { reuse: false, reasons: ['verification options: expected object'] };
  const { expectedIdentity, expectedProducer, authenticatedProducer, policy = {} } = options;
  reasons.push(...identityReasons(expectedIdentity).map((reason) => `expected ${reason}`));
  reasons.push(...producerReasons(expectedProducer).map((reason) => `expected ${reason}`));
  if (fields(receipt, ['schemaVersion', 'identity', 'producer'], 'receipt', reasons)) {
    if (receipt.schemaVersion !== VALIDATION_RECEIPT_SCHEMA_VERSION) reasons.push('receipt: unsupported schemaVersion');
    reasons.push(...identityReasons(receipt.identity), ...producerReasons(receipt.producer));
  }
  if (reasons.length) return { reuse: false, reasons };

  for (const field of Object.keys(expectedIdentity)) {
    if (JSON.stringify(canonical(receipt.identity[field])) !== JSON.stringify(canonical(expectedIdentity[field]))) {
      reasons.push(`identity.${field}: mismatch or incomplete coverage`);
    }
  }
  for (const field of Object.keys(expectedProducer)) {
    if (receipt.producer[field] !== expectedProducer[field]) reasons.push(`producer.${field}: mismatch`);
  }

  if (!object(authenticatedProducer) || authenticatedProducer.authenticated !== true) {
    reasons.push('producer: independently authenticated evidence required');
  } else {
    const facts = authenticatedProducer;
    if (!isDigest(facts.receiptSha256) || facts.receiptSha256 !== validationReceiptSha256(receipt)) {
      reasons.push('producer: authenticated receipt digest mismatch or missing');
    }
    for (const [field, value] of Object.entries({
      repository: expectedIdentity.source.repository,
      headSha: expectedIdentity.source.commit,
      ...expectedProducer,
    })) {
      if (facts[field] !== value) reasons.push(`authenticated producer.${field}: mismatch`);
    }
    if (facts.status !== 'completed' || facts.conclusion !== 'success') {
      reasons.push('producer: completed successful run required');
    }
    if (!['merge_group', 'push'].includes(facts.event)) reasons.push('producer: ineligible event');
    if (facts.trustedRef !== true || !text(facts.ref) || !facts.ref.startsWith('refs/heads/')) {
      reasons.push('producer: independently trusted branch ref required');
    }
  }

  if (!object(policy) || Object.keys(policy).some((key) => !['maxAgeMs', 'nowMs'].includes(key))) {
    reasons.push('policy: invalid or unknown fields');
  } else if (Object.hasOwn(policy, 'nowMs') && !Object.hasOwn(policy, 'maxAgeMs')) {
    reasons.push('policy: nowMs requires maxAgeMs');
  } else if (Object.hasOwn(policy, 'maxAgeMs')) {
    const completedAt = authenticatedProducer?.completedAt;
    const completedMs = typeof completedAt === 'string' ? Date.parse(completedAt) : Number.NaN;
    if (!Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs < 0 ||
        !Number.isSafeInteger(policy.nowMs) || !Number.isFinite(completedMs)) {
      reasons.push('policy: valid maxAgeMs, nowMs and authenticated completion time required');
    } else if (completedMs > policy.nowMs || policy.nowMs - completedMs > policy.maxAgeMs) {
      reasons.push('producer: stale or future completion time');
    }
  }
  return { reuse: reasons.length === 0, reasons };
}
