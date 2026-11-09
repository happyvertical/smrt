import { DesktopContractError } from '../errors.js';
import { deepFreeze } from '../internal/freeze.js';
import {
  isBundleId,
  isIsoUtcTimestamp,
  isLoopbackOrigin,
  isSemver,
  isSlug,
} from '../internal/grammar.js';
import {
  hasClosedKeys,
  isRecord,
  parseStrictJson,
} from '../internal/strict-json.js';
import { type ControlEndpoint, parseControlEndpoint } from './endpoint.js';
import {
  isShellFailureCode,
  normalizeShellFailureCode,
  type ShellFailureCode,
} from './failure-code.js';

/**
 * File name of the instance record in the private state directory.
 *
 * @experimental
 */
export const INSTANCE_RECORD_FILENAME = 'instance.json';

/** @experimental */
export type InstanceState = 'starting' | 'ready' | 'failed';

const states: readonly string[] = ['starting', 'ready', 'failed'];

/**
 * What the desktop shell publishes about the running instance, rewritten
 * atomically on every phase change into
 * `<app_local_data_dir>/.desktop-shell/instance.json` (mode 0600).
 *
 * It is a pointer and a cache, never an authority: liveness and identity are
 * proven by the control channel returning the same `instanceNonce`, not by
 * `pid` or by the file existing. Clients never write, delete or repair it.
 *
 * @experimental
 */
export interface InstanceRecordV1 {
  readonly version: 1;
  readonly productId: string;
  readonly bundleId: string;
  /** 32 lowercase hex characters, new for every shell process. */
  readonly instanceNonce: string;
  /** The shell process id. Diagnostic only; never used for liveness. */
  readonly pid: number;
  /** Semantic version of the shell binary. */
  readonly shellVersion: string;
  /** ISO-8601 UTC time the shell process started. */
  readonly startedAt: string;
  /** ISO-8601 UTC time of the last phase change. */
  readonly updatedAt: string;
  readonly control: ControlEndpoint;
  readonly state: InstanceState;
  /** Exactly `http://127.0.0.1:<port>`. Present if and only if `ready`. */
  readonly origin?: string;
  /** Present if and only if `failed`. */
  readonly failure?: ShellFailureCode;
}

const requiredKeys = [
  'version',
  'productId',
  'bundleId',
  'instanceNonce',
  'pid',
  'shellVersion',
  'startedAt',
  'updatedAt',
  'control',
  'state',
] as const satisfies readonly (keyof InstanceRecordV1)[];
const optionalKeys = ['origin', 'failure'] as const;

const nonce = /^[0-9a-f]{32}$/;

/**
 * True for a 32-character lowercase hex instance nonce.
 *
 * @experimental
 */
export function isInstanceNonce(value: unknown): value is string {
  return typeof value === 'string' && nonce.test(value);
}

function invalid(field: string): DesktopContractError {
  return new DesktopContractError('invalid_field', { field });
}

function validateInstanceRecord(
  input: unknown,
  strict = false,
): InstanceRecordV1 {
  if (!isRecord(input)) throw new DesktopContractError('invalid_document');
  if (!Object.hasOwn(input, 'version')) {
    throw new DesktopContractError('invalid_document');
  }
  if (input.version !== 1) {
    throw new DesktopContractError('unsupported_contract');
  }
  if (!hasClosedKeys(input, requiredKeys, optionalKeys)) {
    throw new DesktopContractError('invalid_document');
  }

  const {
    productId,
    bundleId,
    instanceNonce,
    pid,
    shellVersion,
    startedAt,
    updatedAt,
    state,
    origin,
    failure,
  } = input;
  if (!isSlug(productId)) throw invalid('productId');
  if (!isBundleId(bundleId)) throw invalid('bundleId');
  if (!isInstanceNonce(instanceNonce)) throw invalid('instanceNonce');
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) throw invalid('pid');
  if (!isSemver(shellVersion)) throw invalid('shellVersion');
  if (!isIsoUtcTimestamp(startedAt)) throw invalid('startedAt');
  if (!isIsoUtcTimestamp(updatedAt)) throw invalid('updatedAt');
  if (typeof state !== 'string' || !states.includes(state)) {
    throw invalid('state');
  }
  let control: ControlEndpoint;
  try {
    control = parseControlEndpoint(input.control);
  } catch {
    throw invalid('control');
  }

  if (state === 'ready') {
    if (!isLoopbackOrigin(origin)) throw invalid('origin');
  } else if (origin !== undefined) {
    throw invalid('origin');
  }
  let failureCode: ShellFailureCode | undefined;
  if (state === 'failed') {
    // A code from a newer shell reads as `unknown`, never as tampering.
    // Serializing is strict: a code outside the closed list is not written.
    failureCode = strict
      ? isShellFailureCode(failure)
        ? failure
        : undefined
      : normalizeShellFailureCode(failure);
    if (failureCode === undefined) throw invalid('failure');
  } else if (failure !== undefined) {
    throw invalid('failure');
  }

  return deepFreeze({
    version: 1,
    productId,
    bundleId,
    instanceNonce,
    pid: pid as number,
    shellVersion,
    startedAt,
    updatedAt,
    control,
    state: state as InstanceState,
    ...(state === 'ready' ? { origin: origin as string } : {}),
    ...(failureCode === undefined ? {} : { failure: failureCode }),
  });
}

/**
 * Parse `instance.json`. Throws a `DesktopContractError` with a fixed,
 * value-free message: `invalid_json`, `duplicate_keys`,
 * `unsupported_contract`, `invalid_document` or `invalid_field`.
 *
 * @experimental
 */
export function parseInstanceRecord(json: string): InstanceRecordV1 {
  if (typeof json !== 'string') {
    throw new DesktopContractError('invalid_json');
  }
  const parsed = parseStrictJson(json);
  if (!parsed.ok) {
    throw new DesktopContractError(
      parsed.reason === 'syntax' ? 'invalid_json' : 'duplicate_keys',
    );
  }
  return validateInstanceRecord(parsed.value);
}

/**
 * Serialize a validated record as canonical JSON with a trailing newline.
 *
 * @experimental
 */
export function serializeInstanceRecord(record: InstanceRecordV1): string {
  const r = validateInstanceRecord(record, true);
  return `${JSON.stringify(
    {
      version: r.version,
      productId: r.productId,
      bundleId: r.bundleId,
      instanceNonce: r.instanceNonce,
      pid: r.pid,
      shellVersion: r.shellVersion,
      startedAt: r.startedAt,
      updatedAt: r.updatedAt,
      control: r.control,
      state: r.state,
      ...(r.origin === undefined ? {} : { origin: r.origin }),
      ...(r.failure === undefined ? {} : { failure: r.failure }),
    },
    null,
    2,
  )}\n`;
}
