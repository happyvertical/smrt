import { createHash } from 'node:crypto';

export const phases = ['maintenance', 'stopped', 'migrate', 'verify', 'active'];
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const hash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export class DeploymentError extends Error {
  constructor(message, code = 'SAFETY_GATE') {
    super(message);
    this.name = 'DeploymentError';
    this.code = code;
  }
}
export function demand(condition, reason, code) {
  if (!condition) throw new DeploymentError(reason, code);
}
export const identity = (document) => hash(document.spec.values);
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
function validatePodCapabilities(workload, migration) {
  const pod = workload.podSecurityContext;
  const container = workload.securityContext;
  const positiveId = (id) => Number.isInteger(id) && id > 0 && id <= 2147483647;
  const allowed = (value, keys) =>
    object(value) && Object.keys(value).every((key) => keys.includes(key));
  if (pod !== undefined)
    demand(
      allowed(pod, [
        'runAsNonRoot',
        'runAsUser',
        'runAsGroup',
        'fsGroup',
        'supplementalGroups',
        'seccompProfile',
      ]) &&
        pod.runAsNonRoot === true &&
        positiveId(pod.runAsUser) &&
        positiveId(pod.runAsGroup) &&
        (pod.fsGroup === undefined || positiveId(pod.fsGroup)) &&
        (pod.supplementalGroups === undefined ||
          (Array.isArray(pod.supplementalGroups) &&
            pod.supplementalGroups.length <= 16 &&
            pod.supplementalGroups.every(positiveId) &&
            new Set(pod.supplementalGroups).size ===
              pod.supplementalGroups.length)) &&
        exactKeys(pod.seccompProfile, ['type']) &&
        pod.seccompProfile.type === 'RuntimeDefault',
      'Invalid podSecurityContext',
    );
  if (container !== undefined)
    demand(
      exactKeys(container, [
        'allowPrivilegeEscalation',
        'readOnlyRootFilesystem',
        'capabilities',
      ]) &&
        container.allowPrivilegeEscalation === false &&
        container.readOnlyRootFilesystem === true &&
        exactKeys(container.capabilities, ['drop']) &&
        hash(container.capabilities.drop) === hash(['ALL']),
      'Invalid securityContext',
    );
  if (workload.serviceAccountName !== undefined)
    demand(
      typeof workload.serviceAccountName === 'string' &&
        /^[a-z][a-z0-9-]{0,62}$/.test(workload.serviceAccountName),
      'Invalid serviceAccountName',
    );
  demand(
    migration || !Object.hasOwn(workload, 'observerAccess'),
    'Observer access is migration-only',
  );
  if (migration && Object.hasOwn(workload, 'observerAccess'))
    demand(
      typeof workload.observerAccess === 'boolean' &&
        (!workload.observerAccess || workload.serviceAccountName),
      'Observer access requires explicit migration serviceAccountName',
    );
  if (workload.scratch !== undefined)
    demand(
      Array.isArray(workload.scratch) &&
        workload.scratch.every(
          (volume) =>
            allowed(volume, ['name', 'mountPath', 'sizeLimit', 'medium']) &&
            /^[a-z][a-z0-9-]{0,30}$/.test(volume.name) &&
            volume.name !== 'smrt-observer' &&
            typeof volume.mountPath === 'string' &&
            /^\/(?!var(?:\/|$))(?!run(?:\/|$))(?!proc(?:\/|$))(?!sys(?:\/|$))(?!dev(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(
              volume.mountPath,
            ) &&
            !volume.mountPath.includes('//') &&
            !volume.mountPath
              .split('/')
              .some((part) => ['.', '..'].includes(part)) &&
            (volume.medium === undefined ||
              ['', 'Memory'].includes(volume.medium)) &&
            (volume.sizeLimit === undefined ||
              (typeof volume.sizeLimit === 'string' &&
                volume.sizeLimit.length > 0)),
        ) &&
        new Set(workload.scratch.map((volume) => volume.name)).size ===
          workload.scratch.length &&
        new Set(workload.scratch.map((volume) => volume.mountPath)).size ===
          workload.scratch.length,
      'Invalid scratch volume',
    );
}
export function validateRuntime(runtime) {
  demand(
    object(runtime) &&
      object(runtime.workloads) &&
      Object.keys(runtime.workloads).length > 0 &&
      object(runtime.migration),
    'Expected nonempty RuntimeSnapshot object',
  );
  for (const workload of [
    ...Object.values(runtime.workloads),
    runtime.migration,
  ]) {
    demand(
      object(workload) &&
        typeof workload.image === 'string' &&
        /@sha256:[a-f0-9]{64}$/.test(workload.image) &&
        Array.isArray(workload.command) &&
        workload.command.length > 0 &&
        workload.command.every(
          (part) => typeof part === 'string' && part.length > 0,
        ) &&
        Array.isArray(workload.env),
      'Invalid RuntimeSnapshot image/command/environment',
    );
    validatePodCapabilities(workload, workload === runtime.migration);
    demand(
      !Object.hasOwn(workload, 'envFrom') &&
        workload.env.every((entry) => {
          const reference = entry?.valueFrom?.secretKeyRef;
          return (
            exactKeys(entry, ['name', 'valueFrom']) &&
            typeof entry.name === 'string' &&
            /^[A-Z_][A-Z0-9_]*$/.test(entry.name) &&
            exactKeys(entry.valueFrom, ['secretKeyRef']) &&
            exactKeys(reference, ['name', 'key']) &&
            typeof reference.name === 'string' &&
            /^[a-z][a-z0-9-]{0,30}$/.test(reference.name) &&
            typeof reference.key === 'string' &&
            /^[A-Za-z0-9._-]+$/.test(reference.key)
          );
        }),
      'Runtime environment must contain only named Secret key references; inline values and envFrom are forbidden',
      'ENVIRONMENT_REFERENCE',
    );
  }
  for (const workload of Object.values(runtime.workloads))
    demand(
      Number.isSafeInteger(workload.replicas) && workload.replicas > 0,
      'Invalid RuntimeSnapshot workload capacity',
    );
  return runtime;
}
export function validate(document) {
  const v = document?.spec?.values;
  demand(
    document?.kind === 'HelmRelease' && v,
    'Expected complete HelmRelease document',
  );
  demand(phases.includes(v.release?.phase), 'Unknown release phase');
  demand(/^[a-z0-9][a-z0-9-]{0,39}$/.test(v.release.id), 'Invalid release id');
  demand(
    Number.isSafeInteger(v.release.sequence) && v.release.sequence >= 0,
    'Invalid phase sequence',
  );
  demand(
    Number.isSafeInteger(v.release.attempt) && v.release.attempt > 0,
    'Invalid migration attempt',
  );
  demand(
    v.app?.name && v.app.environment && v.target?.workloads,
    'Missing application runtime',
  );
  demand(
    Object.hasOwn(v, 'current'),
    'Explicit current runtime marker is required',
  );
  demand(
    v.current === false || object(v.current),
    'Current must be false or a RuntimeSnapshot object',
  );
  if (v.current !== false) validateRuntime(v.current);
  validateRuntime(v.target);
  if (
    v.release.sequence === 0 ||
    (v.current === false && v.release.phase === 'maintenance')
  )
    demand(
      v.current === false &&
        v.release.phase === 'maintenance' &&
        v.release.sequence === 0,
      'Bootstrap requires explicit current:false and maintenance sequence zero',
    );
  return v;
}
export function planRelease(previous, target, id) {
  const old = validate(previous);
  demand(
    old.release.phase === 'active',
    'An unfinished release already owns this environment',
  );
  demand(old.release.id !== id, 'Release id must be unique');
  const next = structuredClone(previous);
  if (next.metadata.annotations) {
    delete next.metadata.annotations[
      'smrt.happyvertical.com/binding-reference-set'
    ];
    delete next.metadata.annotations['smrt.happyvertical.com/binding-versions'];
    delete next.metadata.annotations['smrt.happyvertical.com/failed-migration'];
    delete next.metadata.annotations['smrt.happyvertical.com/runtime-recovery'];
    delete next.metadata.annotations[
      'smrt.happyvertical.com/repair-predecessor'
    ];
  }
  next.spec.values = {
    ...old,
    current: old.target,
    target,
    release: {
      id,
      phase: 'maintenance',
      sequence: old.release.sequence + 1,
      attempt: 1,
    },
  };
  validate(next);
  return next;
}
export function transition(document, evidence, recovery = false) {
  const v = validate(document);
  demand(
    evidence.identity === identity(document) && evidence.accepted === true,
    'Stale or unacknowledged phase evidence',
  );
  let next;
  if (recovery) {
    demand(
      ['migrate', 'verify', 'active'].includes(v.release.phase),
      'Recovery requires migrate, verify or active',
    );
    if (v.release.phase === 'migrate')
      demand(
        evidence.failedMigration?.jobUid &&
          evidence.failedMigration.targetIdentity === hash(v.target) &&
          evidence.proven === true,
        'Migration recovery requires fully correlated terminal failed-attempt proof',
        'MIGRATION_RECOVERY',
      );
    if (v.release.phase !== 'migrate')
      demand(
        typeof evidence.revision === 'string' && evidence.revision.length > 0,
        'Runtime recovery requires exact revision binding',
        'MIGRATION_REPAIR',
      );
    next = v.release.phase === 'active' ? 'maintenance' : 'stopped';
  } else {
    demand(
      !evidence.failedMigration,
      'Failed migration recovery proof cannot activate runtime',
      'MIGRATION_RECOVERY',
    );
    if (v.release.phase === 'stopped') {
      const failed = JSON.parse(
        document.metadata.annotations?.[
          'smrt.happyvertical.com/failed-migration'
        ] ?? 'null',
      );
      const runtimeRecovery = JSON.parse(
        document.metadata.annotations?.[
          'smrt.happyvertical.com/runtime-recovery'
        ] ?? 'null',
      );
      demand(
        !runtimeRecovery || runtimeRecovery.attempt !== v.release.attempt,
        'Runtime recovery requires explicit reviewed repair before migration',
        'MIGRATION_REPAIR',
      );
      demand(
        !failed || failed.attempt !== v.release.attempt,
        'Failed migration attempt requires explicit reviewed repair before migration',
        'MIGRATION_REPAIR',
      );
    }
    demand(evidence.proven === true, 'Phase safety proof failed');
    next = phases[phases.indexOf(v.release.phase) + 1];
    demand(next, 'Release is already active');
  }
  const result = structuredClone(document);
  result.spec.values.release.phase = next;
  result.spec.values.release.sequence++;
  // Active failure preserves the entire target runtime while maintenance removes traffic.
  if (v.release.phase === 'active')
    result.spec.values.current = structuredClone(v.target);
  result.metadata.annotations ??= {};
  if (recovery && v.release.phase === 'migrate')
    result.metadata.annotations['smrt.happyvertical.com/failed-migration'] =
      JSON.stringify(evidence.failedMigration);
  if (recovery && ['verify', 'active'].includes(v.release.phase))
    result.metadata.annotations['smrt.happyvertical.com/runtime-recovery'] =
      JSON.stringify({
        reason:
          v.release.phase === 'verify'
            ? 'runtime-verification-failed'
            : 'active-health-failed',
        phase: v.release.phase,
        releaseId: v.release.id,
        attempt: v.release.attempt,
        targetIdentity: hash(v.target),
        identity: identity(document),
        revision: evidence.revision,
        failureCode: evidence.failureCode ?? 'OPERATOR_RECOVERY',
      });
  result.metadata.annotations['smrt.happyvertical.com/predecessor'] = hash({
    identity: evidence.identity,
    revision: evidence.revision,
    bindings: evidence.bindings,
  });
  return result;
}

export async function applyOrResume(
  config,
  adapter,
  { planned, recovery = false } = {},
) {
  const snapshot = await adapter.read();
  const current = snapshot.document;
  if (current) validate(current);
  if (planned) {
    const v = validate(planned);
    demand(
      v.release.phase === 'maintenance',
      'New release must begin in maintenance',
    );
    if (current) {
      const expected = planRelease(current, v.target, v.release.id);
      const predecessor = await adapter.observe(current, snapshot.revision);
      demand(
        predecessor.accepted === true &&
          predecessor.proven === true &&
          predecessor.identity === identity(current) &&
          predecessor.revision === snapshot.revision,
        'New release requires an exact accepted healthy predecessor',
      );
      demand(
        identity(expected) === identity(planned),
        'Plan does not preserve the complete current runtime',
      );
    } else
      demand(
        v.current === false && v.release.sequence === 0,
        'Bootstrap requires current:false and maintenance sequence zero',
      );
    const proof = await adapter.preflight(planned);
    planned = structuredClone(planned);
    planned.metadata.annotations ??= {};
    if (proof?.bindings)
      planned.metadata.annotations['smrt.happyvertical.com/binding-versions'] =
        proof.bindings;
    if (proof?.bindingReferences)
      planned.metadata.annotations[
        'smrt.happyvertical.com/binding-reference-set'
      ] = JSON.stringify(proof.bindingReferences);
    return adapter.cas(snapshot, planned);
  }
  demand(current, 'No release exists; publish a reviewed bootstrap plan');
  const evidence = await adapter.observe(current, snapshot.revision, {
    allowFailedMigration:
      recovery && current.spec.values.release.phase === 'migrate',
  });
  if (current.spec.values.release.phase === 'active' && !recovery) {
    if (evidence.proven === true) return { complete: true, evidence };
    recovery = true;
  }
  const next = transition(current, evidence, recovery);
  await adapter.preflight(next);
  return adapter.cas(snapshot, next);
}

export function repairRelease(document, target, evidence) {
  const v = validate(document);
  demand(
    v.release.phase === 'stopped' &&
      evidence.accepted === true &&
      evidence.proven === true &&
      evidence.identity === identity(document),
    'Repair requires acknowledged stopped runtime with no writers',
    'MIGRATION_REPAIR',
  );
  const failed = JSON.parse(
    document.metadata.annotations?.[
      'smrt.happyvertical.com/failed-migration'
    ] ?? 'null',
  );
  const runtimeRecovery = JSON.parse(
    document.metadata.annotations?.[
      'smrt.happyvertical.com/runtime-recovery'
    ] ?? 'null',
  );
  const failedAttempt =
    failed?.jobUid &&
    failed.releaseId === v.release.id &&
    failed.attempt === v.release.attempt &&
    failed.targetIdentity === hash(v.target);
  const runtimeAttempt =
    runtimeRecovery &&
    ['verify', 'active'].includes(runtimeRecovery.phase) &&
    runtimeRecovery.reason ===
      (runtimeRecovery.phase === 'verify'
        ? 'runtime-verification-failed'
        : 'active-health-failed') &&
    runtimeRecovery.releaseId === v.release.id &&
    runtimeRecovery.attempt === v.release.attempt &&
    runtimeRecovery.targetIdentity === hash(v.target) &&
    /^[a-f0-9]{64}$/.test(runtimeRecovery.identity ?? '') &&
    typeof runtimeRecovery.revision === 'string' &&
    runtimeRecovery.revision.length > 0;
  demand(
    failedAttempt || runtimeAttempt,
    'Repair does not match a retained failed migration or current runtime recovery',
    'MIGRATION_REPAIR',
  );
  validateRuntime(target);
  const next = structuredClone(document);
  next.spec.values.target = structuredClone(target);
  next.spec.values.release.attempt++;
  next.spec.values.release.sequence++;
  next.metadata.annotations['smrt.happyvertical.com/repair-predecessor'] =
    JSON.stringify({
      identity: identity(document),
      releaseId: v.release.id,
      ...(failedAttempt
        ? { failedJobUid: failed.jobUid }
        : { runtimeRecovery }),
      previousAttempt: v.release.attempt,
      nextAttempt: next.spec.values.release.attempt,
      previousTargetIdentity: hash(v.target),
    });
  return next;
}
export function validateRepairEvidence(document, receipt) {
  const raw =
    document.metadata.annotations?.[
      'smrt.happyvertical.com/repair-predecessor'
    ];
  if (!raw) return;
  const predecessor = JSON.parse(raw);
  const recovery = receipt.recovery;
  demand(
    recovery &&
      hash(recovery.predecessor) === hash(predecessor) &&
      recovery.targetIdentity === hash(document.spec.values.target) &&
      recovery.ledgerState === 'reconciled' &&
      /^[a-f0-9]{64}$/.test(recovery.ledgerEvidenceIdentity ?? ''),
    'Repair validation must bind failed attempt, corrected target and reconciled durable ledger; needs-repair cannot retry',
    'MIGRATION_REPAIR',
  );
}
export async function repair(config, adapter, target) {
  const snapshot = await adapter.read();
  const evidence = await adapter.observe(snapshot.document, snapshot.revision);
  const next = repairRelease(snapshot.document, target, evidence);
  const proof = await adapter.preflight(next);
  if (proof?.bindings)
    next.metadata.annotations['smrt.happyvertical.com/binding-versions'] =
      proof.bindings;
  if (proof?.bindingReferences)
    next.metadata.annotations['smrt.happyvertical.com/binding-reference-set'] =
      JSON.stringify(proof.bindingReferences);
  return adapter.cas(snapshot, next);
}
