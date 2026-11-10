import type {
  DurableJobPayloadIntegrity,
  DurableJobPayloadSigner,
} from './durable-payload-integrity.js';

/** Durable, versioned requirement persisted in AgentSchedule.methodArgs. */
export interface ScheduleAdmissionPolicy {
  version: 1;
  requireIntegrity: true;
  queue: string;
  keyId: string;
}

/** Absent policy preserves legacy behavior; any malformed present policy fails closed. */
export function getScheduleAdmissionPolicy(
  args: unknown,
): ScheduleAdmissionPolicy | null {
  if (typeof args === 'string') args = JSON.parse(args);
  if (!record(args))
    throw new TypeError('Schedule method_args must be a JSON object');
  if (!Object.hasOwn(args, '_scheduleAdmissionPolicy')) return null;
  const value = args._scheduleAdmissionPolicy;
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !==
      'keyId,queue,requireIntegrity,version' ||
    value.version !== 1 ||
    value.requireIntegrity !== true ||
    typeof value.queue !== 'string' ||
    !value.queue.trim() ||
    typeof value.keyId !== 'string' ||
    !value.keyId.trim() ||
    value.keyId.length > 256
  ) {
    throw new TypeError('Unsupported or malformed schedule admission policy');
  }
  return {
    version: 1,
    requireIntegrity: true,
    queue: value.queue,
    keyId: value.keyId,
  };
}

/** Purpose-separated, immutable JSON identity of one scheduler admission. */
export interface ScheduleAdmissionPayload {
  purpose: 'smrt.schedule-admission';
  version: 1;
  keyId: string;
  jobId: string;
  tenantId: string | null;
  scheduleId: string;
  scheduledFor: string;
  queue: string;
  objectType: string;
  objectId: string | null;
  method: string;
  args: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function identity(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`Schedule admission requires ${name}`);
  }
  return value;
}

/**
 * Build the public signature payload from an authoritative persisted job row.
 *
 * This pure helper never signs or acquires a key. Only `_scheduleAdmission` is
 * omitted; every other persisted argument, including constructor/static consent
 * metadata, participates. Lifecycle fields may change during a legitimate retry.
 * Malformed identities or noncanonical UTC occurrence metadata throw.
 */
export function getScheduleAdmissionPayload(
  job: unknown,
  keyId: string,
): ScheduleAdmissionPayload {
  if (!job || typeof job !== 'object') {
    throw new TypeError('Schedule admission requires a job');
  }
  const row = job as Record<string, unknown>;
  if (!record(row.args)) {
    throw new TypeError('Schedule admission requires JSON object arguments');
  }
  const scheduledFor = identity(row.args._scheduledFor, 'scheduledFor');
  const epoch = Date.parse(scheduledFor);
  if (
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString() !== scheduledFor
  ) {
    throw new TypeError(
      'Schedule admission requires canonical UTC scheduledFor',
    );
  }
  const signatureKey = identity(keyId, 'keyId');
  if (signatureKey.length > 256) throw new TypeError('Invalid admission keyId');
  const policy = getScheduleAdmissionPolicy(row.args);
  if (policy && (policy.queue !== row.queue || policy.keyId !== signatureKey)) {
    throw new TypeError('Schedule admission does not match its durable policy');
  }
  const { _scheduleAdmission: _, ...argumentsWithoutSignature } = row.args;
  // Match the representation actually stored as JSON, preserving own __proto__
  // keys and Date serialization. Never retain a mutable reference to caller args.
  const args = JSON.parse(JSON.stringify(argumentsWithoutSignature)) as Record<
    string,
    unknown
  >;
  return {
    purpose: 'smrt.schedule-admission',
    version: 1,
    keyId: signatureKey,
    jobId: identity(row.id, 'jobId'),
    tenantId: row.tenantId === null ? null : identity(row.tenantId, 'tenantId'),
    scheduleId: identity(row.args._scheduleId, 'scheduleId'),
    scheduledFor,
    queue: identity(row.queue, 'queue'),
    objectType: identity(row.objectType, 'objectType'),
    objectId: row.objectId === null ? null : identity(row.objectId, 'objectId'),
    method: identity(row.method, 'method'),
    args,
  };
}

/**
 * Verify one exact admitted job, failing closed on missing/unknown metadata.
 *
 * `signer.verify` may be a trusted keyring retaining old verification keys while
 * `signer.keyId` selects a new minting key. Unknown or retired keys must deny.
 * A valid signature proves admission, never current user authority, deduplication
 * or exactly-once execution. No protection is claimed against code holding keys.
 */
export function verifyScheduleAdmission(
  job: unknown,
  signer: DurableJobPayloadSigner,
): boolean {
  try {
    if (!job || typeof job !== 'object') return false;
    const args = (job as Record<string, unknown>).args;
    if (!record(args)) return false;
    const integrity = args._scheduleAdmission;
    if (
      !record(integrity) ||
      Object.keys(integrity).length !== 3 ||
      !['version', 'keyId', 'signature'].every((key) =>
        Object.hasOwn(integrity, key),
      ) ||
      integrity.version !== 1 ||
      typeof integrity.keyId !== 'string' ||
      !integrity.keyId.trim() ||
      integrity.keyId.length > 256 ||
      typeof integrity.signature !== 'string' ||
      !integrity.signature.trim()
    ) {
      return false;
    }
    return (
      signer.verify(
        getScheduleAdmissionPayload(job, integrity.keyId),
        integrity as unknown as DurableJobPayloadIntegrity,
      ) === true
    );
  } catch {
    return false;
  }
}
