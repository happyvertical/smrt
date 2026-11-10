import {
  demand,
  hash,
  normalizedIngressRecords,
  validate,
  assertNoPendingTls,
} from './release.mjs';
export const tlsAnnotation = 'smrt.happyvertical.com/tls-transition';
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) =>
  object(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const sha = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const revision = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const name = (v) => typeof v === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(v);
const refs = (document) =>
  normalizedIngressRecords(document.spec.values, document.metadata.name).map(
    (r) => ({
      name: r.name,
      host: r.host,
      workload: r.workload,
      tlsSecretName: r.tlsSecretName ?? null,
    }),
  );
export function tlsMarker(document) {
  const raw = document?.metadata?.annotations?.[tlsAnnotation];
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    demand(false, 'Malformed TLS transition annotation', 'TLS_TRANSITION');
  }
}
export const assertTlsSettled = assertNoPendingTls;
function frame(document) {
  const copy = structuredClone(document);
  if (copy.metadata.annotations) {
    delete copy.metadata.annotations[tlsAnnotation];
    delete copy.metadata.annotations['smrt.happyvertical.com/binding-versions'];
    if (!Object.keys(copy.metadata.annotations).length)
      delete copy.metadata.annotations;
  }
  return hash(copy);
}
export function replaceTlsReferences(document, references) {
  const next = structuredClone(document);
  const ingress = next.spec.values.ingress;
  const primary = ingress.name ?? next.metadata.name;
  for (const ref of references) {
    if (ref.name === primary) ingress.tlsSecretName = ref.tlsSecretName;
    else {
      const route = ingress.additionalRoutes?.find((r) => r.name === ref.name);
      demand(route, 'Unknown TLS route', 'TLS_TRANSITION');
      route.tlsSecretName = ref.tlsSecretName;
    }
  }
  return next;
}
export function planTlsRotation(snapshot, input, id) {
  const document = snapshot?.document;
  const values = validate(document);
  assertTlsSettled(document);
  demand(
    values.release.phase === 'active' && revision(snapshot.revision),
    'TLS rotation requires an existing active exact predecessor',
    'TLS_TRANSITION',
  );
  demand(
    name(id) && tlsMarker(document)?.id !== id,
    'Unique TLS transition id required',
    'TLS_TRANSITION',
  );
  demand(
    Array.isArray(input) &&
      input.length > 0 &&
      input.length <= 9 &&
      input.every(
        (r) =>
          exact(r, ['name', 'tlsSecretName']) &&
          name(r.name) &&
          name(r.tlsSecretName),
      ) &&
      new Set(input.map((r) => r.name)).size === input.length,
    'Expected bounded named TLS references only',
    'TLS_TRANSITION',
  );
  const before = refs(document);
  demand(
    input.every((r) =>
      before.some((b) => b.name === r.name && b.tlsSecretName),
    ),
    'TLS rotation changes existing TLS-enabled routes only',
    'TLS_TRANSITION',
  );
  const primary = document.spec.values.ingress.name ?? document.metadata.name;
  demand(
    input.every(
      (r) => r.tlsSecretName.length <= (r.name === primary ? 31 : 63),
    ),
    'TLS reference exceeds chart name bound',
    'TLS_TRANSITION',
  );
  const candidate = replaceTlsReferences(document, input);
  const after = refs(candidate);
  demand(
    hash(before) !== hash(after),
    'TLS rotation must change a reference',
    'TLS_TRANSITION',
  );
  return {
    apiVersion: 'smrt.happyvertical.com/tls-plan-v1',
    id,
    predecessor: {
      revision: snapshot.revision,
      documentSha256: hash(document),
      document: structuredClone(document),
    },
    before,
    after,
  };
}
export function validateTlsPlan(plan) {
  demand(
    exact(plan, ['apiVersion', 'id', 'predecessor', 'before', 'after']) &&
      plan.apiVersion === 'smrt.happyvertical.com/tls-plan-v1' &&
      exact(plan.predecessor, ['revision', 'documentSha256', 'document']) &&
      sha(plan.predecessor.documentSha256) &&
      hash(plan.predecessor.document) === plan.predecessor.documentSha256 &&
      Array.isArray(plan.before) &&
      Array.isArray(plan.after),
    'Invalid TLS plan',
    'TLS_TRANSITION',
  );
  demand(
    [...plan.before, ...plan.after].every(
      (r) =>
        exact(r, ['name', 'host', 'workload', 'tlsSecretName']) &&
        name(r.name) &&
        typeof r.host === 'string' &&
        r.host.length > 0 &&
        typeof r.workload === 'string' &&
        (r.tlsSecretName === null || name(r.tlsSecretName)),
    ),
    'Invalid TLS route records',
    'TLS_TRANSITION',
  );
  const changes = plan.after
    .filter((r, i) => r.tlsSecretName !== plan.before[i]?.tlsSecretName)
    .map(({ name, tlsSecretName }) => ({ name, tlsSecretName }));
  const expected = planTlsRotation(
    {
      document: plan.predecessor.document,
      revision: plan.predecessor.revision,
    },
    changes,
    plan.id,
  );
  demand(
    hash(expected) === hash(plan),
    'TLS plan is not a bounded reference transition',
    'TLS_TRANSITION',
  );
  return plan;
}
export function tlsDocument(
  plan,
  retained,
  status = 'pending',
  rollback = null,
  runtimeTemplates = [],
) {
  validateTlsPlan(plan);
  demand(
    ['pending', 'complete', 'rolling-back', 'rolled-back'].includes(status),
    'Unknown TLS transition state',
    'TLS_TRANSITION',
  );
  const before = ['rolling-back', 'rolled-back'].includes(status);
  const document = replaceTlsReferences(
    plan.predecessor.document,
    before
      ? plan.before.filter((r) => r.tlsSecretName)
      : plan.after.filter((r) => r.tlsSecretName),
  );
  const core = {
    apiVersion: 'smrt.happyvertical.com/tls-transition-v1',
    id: plan.id,
    planIdentity: hash(plan),
    predecessor: {
      revision: plan.predecessor.revision,
      documentSha256: plan.predecessor.documentSha256,
    },
    before: plan.before,
    after: plan.after,
    retained,
    runtimeTemplates,
  };
  const marker = { ...core, identity: hash(core), status, rollback };
  document.metadata.annotations ??= {};
  document.metadata.annotations[tlsAnnotation] = JSON.stringify(marker);
  demand(
    Object.entries(document.metadata.annotations).reduce(
      (n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(String(v)),
      0,
    ) <= 262144,
    'TLS transition exceeds annotation size bound',
    'TLS_TRANSITION',
  );
  return document;
}
export function validateTlsCurrent(plan, document) {
  validateTlsPlan(plan);
  const marker = tlsMarker(document);
  demand(
    exact(marker, [
      'apiVersion',
      'id',
      'planIdentity',
      'predecessor',
      'before',
      'after',
      'retained',
      'runtimeTemplates',
      'identity',
      'status',
      'rollback',
    ]) &&
      ['pending', 'complete', 'rolling-back', 'rolled-back'].includes(
        marker.status,
      ) &&
      Array.isArray(marker.retained) &&
      marker.retained.length > 0 &&
      marker.retained.length <= 18 &&
      marker.retained.every(
        (r) =>
          exact(r, ['name', 'uid', 'resourceVersion', 'leafSha256']) &&
          name(r.name) &&
          typeof r.uid === 'string' &&
          r.uid.length > 0 &&
          r.uid.length <= 128 &&
          typeof r.resourceVersion === 'string' &&
          r.resourceVersion.length > 0 &&
          r.resourceVersion.length <= 64 &&
          sha(r.leafSha256),
      ) &&
      new Set(marker.retained.map((r) => r.name)).size ===
        marker.retained.length,
    'Invalid retained TLS transition',
    'TLS_TRANSITION',
  );
  const required = new Set(
    [...plan.before, ...plan.after].map((r) => r.tlsSecretName).filter(Boolean),
  );
  demand(
    required.size === marker.retained.length &&
      marker.retained.every((r) => required.has(r.name)),
    'Retained TLS bindings differ from plan',
    'TLS_TRANSITION',
  );
  demand(
    Array.isArray(marker.runtimeTemplates) &&
      marker.runtimeTemplates.length > 0 &&
      marker.runtimeTemplates.length <= 60 &&
      marker.runtimeTemplates.every(
        (r) =>
          exact(r, ['kind', 'name', 'uid', 'templateSha256']) &&
          ['Deployment', 'CronJob'].includes(r.kind) &&
          name(r.name) &&
          typeof r.uid === 'string' &&
          r.uid.length > 0 &&
          r.uid.length <= 128 &&
          sha(r.templateSha256),
      ),
    'Invalid preserved runtime template identities',
    'TLS_TRANSITION',
  );
  const rollback = marker.rollback;
  demand(
    ['rolling-back', 'rolled-back'].includes(marker.status)
      ? exact(rollback, ['revision', 'documentSha256', 'failureIdentity']) &&
          revision(rollback.revision) &&
          sha(rollback.documentSha256) &&
          sha(rollback.failureIdentity)
      : rollback === null,
    'Invalid TLS rollback association',
    'TLS_TRANSITION',
  );
  const expected = tlsDocument(
    plan,
    marker.retained,
    marker.status,
    rollback,
    marker.runtimeTemplates,
  );
  demand(
    hash(tlsMarker(expected)) === hash(marker) &&
      frame(expected) === frame(document),
    'TLS transition has unrelated document drift',
    'TLS_TRANSITION',
  );
  return marker;
}
function healthyTlsProof(proof, snapshot) {
  return (
    proof?.accepted === true &&
    proof.proven === true &&
    proof.revision === snapshot.revision &&
    proof.documentSha256 === hash(snapshot.document) &&
    Number.isSafeInteger(proof.observedAt) &&
    proof.observedAt <= Date.now() &&
    proof.observedAt >= Date.now() - 30000
  );
}
export async function applyTlsRotation(config, adapter, input) {
  const plan = validateTlsPlan(input);
  const snapshot = await adapter.read();
  if (
    snapshot.revision === plan.predecessor.revision &&
    hash(snapshot.document) === plan.predecessor.documentSha256
  ) {
    const proof = await adapter.observeTls(
      snapshot.document,
      snapshot.revision,
    );
    demand(
      healthyTlsProof(proof, snapshot),
      'TLS predecessor is not accepted and healthy',
      'TLS_TRANSITION',
    );
    const next = await adapter.prepareTls(plan, 'pending', null);
    validateTlsCurrent(plan, next);
    const fresh = await adapter.observeTls(
      snapshot.document,
      snapshot.revision,
    );
    demand(
      healthyTlsProof(fresh, snapshot),
      'TLS predecessor changed during preflight',
      'TLS_TRANSITION',
    );
    demand(
      hash(fresh.runtimeTemplates) === hash(tlsMarker(next).runtimeTemplates),
      'Runtime templates changed during TLS preflight',
      'TLS_TRANSITION',
    );
    const result = await adapter.casTls(snapshot, next);
    return { ...result, status: 'pending' };
  }
  const marker = validateTlsCurrent(plan, snapshot.document);
  const proof = await adapter.observeTls(snapshot.document, snapshot.revision);
  if (!proof.proven) return { status: marker.status, evidence: proof };
  demand(
    healthyTlsProof(proof, snapshot),
    'TLS acknowledgement is stale or unaccepted',
    'TLS_TRANSITION',
  );
  if (['complete', 'rolled-back'].includes(marker.status))
    return { status: marker.status, complete: true, evidence: proof };
  const next = structuredClone(snapshot.document);
  const updated = {
    ...marker,
    status: marker.status === 'pending' ? 'complete' : 'rolled-back',
  };
  next.metadata.annotations[tlsAnnotation] = JSON.stringify(updated);
  const result = await adapter.casTls(snapshot, next);
  return { ...result, status: updated.status };
}
function assertCorrelatedFailure(proof, plan, marker, snapshot) {
  const failure = proof.tlsFailure;
  const changed = new Set(
    plan.after
      .filter((r, i) => r.tlsSecretName !== plan.before[i].tlsSecretName)
      .map((r) => r.host),
  );
  demand(
    proof.accepted === true &&
      proof.proven === false &&
      proof.failureCode === 'TLS_CORRELATED_FAILURE' &&
      exact(failure, [
        'transitionIdentity',
        'documentSha256',
        'revision',
        'bindings',
        'hosts',
        'observedAt',
      ]) &&
      failure.transitionIdentity === marker.identity &&
      failure.documentSha256 === hash(snapshot.document) &&
      failure.revision === snapshot.revision &&
      sha(failure.bindings) &&
      Number.isSafeInteger(failure.observedAt) &&
      failure.observedAt <= Date.now() &&
      failure.observedAt >= Date.now() - 30000 &&
      Array.isArray(failure.hosts) &&
      failure.hosts.length > 0 &&
      failure.hosts.length <= 9 &&
      failure.hosts.every(
        (h) =>
          exact(h, [
            'host',
            'expectedLeafSha256',
            'servedLeafSha256',
            'code',
            'observedAt',
          ]) &&
          Number.isSafeInteger(h.observedAt) &&
          h.observedAt >= Date.now() - 30000 &&
          h.observedAt <= Date.now() &&
          changed.has(h.host) &&
          ['TLS_TRUST', 'TLS_HOSTNAME', 'TLS_CERTIFICATE'].includes(h.code) &&
          sha(h.servedLeafSha256) &&
          h.expectedLeafSha256 ===
            marker.retained.find(
              (r) =>
                r.name ===
                plan.after.find((a) => a.host === h.host)?.tlsSecretName,
            )?.leafSha256,
      ),
    'Rollback requires a fresh correlated TLS-only failure',
    'TLS_TRANSITION',
  );
  return failure;
}
export async function rollbackTlsRotation(config, adapter, input) {
  const plan = validateTlsPlan(input);
  const snapshot = await adapter.read();
  const marker = validateTlsCurrent(plan, snapshot.document);
  if (['rolling-back', 'rolled-back'].includes(marker.status))
    return applyTlsRotation(config, adapter, plan);
  const proof = await adapter.observeTls(snapshot.document, snapshot.revision);
  const failure = assertCorrelatedFailure(proof, plan, marker, snapshot);
  const rollback = {
    revision: snapshot.revision,
    documentSha256: hash(snapshot.document),
    failureIdentity: hash(failure),
  };
  const next = await adapter.prepareTls(
    plan,
    'rolling-back',
    rollback,
    marker.retained,
    marker.runtimeTemplates,
  );
  validateTlsCurrent(plan, next);
  const fresh = await adapter.observeTls(snapshot.document, snapshot.revision);
  const latest = assertCorrelatedFailure(fresh, plan, marker, snapshot);
  const updated = tlsMarker(next);
  updated.rollback = {
    revision: snapshot.revision,
    documentSha256: hash(snapshot.document),
    failureIdentity: hash(latest),
  };
  next.metadata.annotations[tlsAnnotation] = JSON.stringify(updated);
  return { ...(await adapter.casTls(snapshot, next)), status: 'rolling-back' };
}
