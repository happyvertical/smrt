/**
 * Browser transport for bounded data-surface action envelopes.
 *
 * This structurally mirrors smrt-types without importing another SMRT package.
 * The server remains responsible for authority, descriptor allowlists, and
 * confirmation-token validation; this boundary only rejects malformed replies.
 */

export type SmrtWebDataSurfaceJsonPrimitive = string | number | boolean | null;
export type SmrtWebDataSurfaceJsonValue =
  | SmrtWebDataSurfaceJsonPrimitive
  | SmrtWebDataSurfaceJsonValue[]
  | { [key: string]: SmrtWebDataSurfaceJsonValue };

export interface SmrtWebDataSurfaceIdentity {
  surfaceId: string;
  kind: 'table' | 'list' | 'report' | 'custom';
  subject?: { type: string; id: string; label?: string };
}

export type SmrtWebDataSurfaceSelection =
  | { scope: 'current-page' }
  | { scope: 'explicit-ids'; rowIds: Array<string | number> }
  | { scope: 'all-matching'; queryFingerprint: string };

export interface SmrtWebDataSurfaceActionRequest {
  version: 1;
  requestId: string;
  identity: SmrtWebDataSurfaceIdentity;
  actionId: string;
  phase: 'preview' | 'apply';
  expectedRevision: number;
  /** Required by the server for apply; retries with the same key replay safely. */
  idempotencyKey?: string;
  selection: SmrtWebDataSurfaceSelection;
  payload?: SmrtWebDataSurfaceJsonValue;
  confirmationToken?: string;
}

export interface SmrtWebDataSurfaceActionResult {
  version: 1;
  requestId: string;
  identity: SmrtWebDataSurfaceIdentity;
  actionId: string;
  phase: 'preview' | 'apply';
  ok: boolean;
  reason?: string;
  confirmationToken?: string;
  details?: { [key: string]: SmrtWebDataSurfaceJsonValue };
}

export interface SmrtWebDataSurfaceActionTransport {
  action(
    request: SmrtWebDataSurfaceActionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export const MAX_SMRT_WEB_DATA_SURFACE_ACTION_RESULT_BYTES = 1_000_000;
export const MAX_SMRT_WEB_DATA_SURFACE_ACTION_IDENTIFIER_LENGTH = 256;
export const MAX_SMRT_WEB_DATA_SURFACE_ACTION_JSON_DEPTH = 16;
export const MAX_SMRT_WEB_DATA_SURFACE_ACTION_CONTAINER_ITEMS = 1_000;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new TypeError(`${label} contains a forbidden key`);
    }
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(`${label} contains ${key}`);
  }
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SMRT_WEB_DATA_SURFACE_ACTION_IDENTIFIER_LENGTH
  ) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function json(
  value: unknown,
  label: string,
  depth = 0,
): SmrtWebDataSurfaceJsonValue {
  if (depth > MAX_SMRT_WEB_DATA_SURFACE_ACTION_JSON_DEPTH) {
    throw new TypeError(`${label} exceeds JSON depth`);
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SMRT_WEB_DATA_SURFACE_ACTION_CONTAINER_ITEMS) {
      throw new TypeError(`${label} exceeds the container-item limit`);
    }
    return value.map((entry, index) =>
      json(entry, `${label}[${index}]`, depth + 1),
    );
  }
  const source = object(value, label);
  if (
    Object.keys(source).length >
    MAX_SMRT_WEB_DATA_SURFACE_ACTION_CONTAINER_ITEMS
  ) {
    throw new TypeError(`${label} exceeds the container-item limit`);
  }
  const result: { [key: string]: SmrtWebDataSurfaceJsonValue } =
    Object.create(null);
  for (const [key, entry] of Object.entries(source)) {
    result[key] = json(entry, `${label}.${key}`, depth + 1);
  }
  return result;
}

function identity(value: unknown): SmrtWebDataSurfaceIdentity {
  const source = object(value, 'Data surface identity');
  exactKeys(source, ['surfaceId', 'kind', 'subject'], 'Data surface identity');
  const kind = source.kind;
  if (!['table', 'list', 'report', 'custom'].includes(kind as string)) {
    throw new TypeError('Data surface identity kind is invalid');
  }
  const result: SmrtWebDataSurfaceIdentity = {
    surfaceId: identifier(source.surfaceId, 'Data surface identity surfaceId'),
    kind: kind as SmrtWebDataSurfaceIdentity['kind'],
  };
  if (source.subject !== undefined) {
    const subject = object(source.subject, 'Data surface identity subject');
    exactKeys(
      subject,
      ['type', 'id', 'label'],
      'Data surface identity subject',
    );
    result.subject = {
      type: identifier(subject.type, 'Data surface identity subject type'),
      id: identifier(subject.id, 'Data surface identity subject id'),
      ...(subject.label === undefined
        ? {}
        : {
            label: identifier(
              subject.label,
              'Data surface identity subject label',
            ),
          }),
    };
  }
  return result;
}

function sameIdentity(
  left: SmrtWebDataSurfaceIdentity,
  right: SmrtWebDataSurfaceIdentity,
): boolean {
  return (
    left.surfaceId === right.surfaceId &&
    left.kind === right.kind &&
    left.subject?.type === right.subject?.type &&
    left.subject?.id === right.subject?.id
  );
}

/** Fail closed before an action result reaches browser state. */
export function normalizeSmrtWebDataSurfaceActionResult(
  value: unknown,
): SmrtWebDataSurfaceActionResult {
  const serialized = JSON.stringify(value);
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength >
      MAX_SMRT_WEB_DATA_SURFACE_ACTION_RESULT_BYTES
  ) {
    throw new TypeError(
      'Data surface action result exceeds the maximum byte limit',
    );
  }
  const source = object(value, 'Data surface action result');
  exactKeys(
    source,
    [
      'version',
      'requestId',
      'identity',
      'actionId',
      'phase',
      'ok',
      'reason',
      'confirmationToken',
      'details',
    ],
    'Data surface action result',
  );
  if (
    source.version !== 1 ||
    (source.phase !== 'preview' && source.phase !== 'apply')
  ) {
    throw new TypeError(
      'Data surface action result has an invalid version or phase',
    );
  }
  if (typeof source.ok !== 'boolean') {
    throw new TypeError('Data surface action result ok must be boolean');
  }
  const result: SmrtWebDataSurfaceActionResult = {
    version: 1,
    requestId: identifier(
      source.requestId,
      'Data surface action result requestId',
    ),
    identity: identity(source.identity),
    actionId: identifier(
      source.actionId,
      'Data surface action result actionId',
    ),
    phase: source.phase,
    ok: source.ok,
  };
  if (source.reason !== undefined)
    result.reason = identifier(
      source.reason,
      'Data surface action result reason',
    );
  if (source.confirmationToken !== undefined)
    result.confirmationToken = identifier(
      source.confirmationToken,
      'Data surface action result confirmationToken',
    );
  if (source.details !== undefined) {
    const details = json(source.details, 'Data surface action result details');
    if (
      Array.isArray(details) ||
      details === null ||
      typeof details !== 'object'
    ) {
      throw new TypeError(
        'Data surface action result details must be an object',
      );
    }
    result.details = details as SmrtWebDataSurfaceActionResult['details'];
  }
  return result;
}

export async function executeSmrtWebDataSurfaceAction(
  transport: SmrtWebDataSurfaceActionTransport,
  request: SmrtWebDataSurfaceActionRequest,
  options?: { signal?: AbortSignal },
): Promise<SmrtWebDataSurfaceActionResult> {
  const result = normalizeSmrtWebDataSurfaceActionResult(
    await transport.action(request, options),
  );
  if (
    result.requestId !== request.requestId ||
    result.actionId !== request.actionId ||
    result.phase !== request.phase ||
    !sameIdentity(result.identity, request.identity)
  ) {
    throw new TypeError(
      'Data surface action result does not match its request',
    );
  }
  return result;
}
