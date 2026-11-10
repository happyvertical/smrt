/**
 * Errors for target selection and native-binary verification.
 *
 * Like `DesktopContractError`, the message is fixed text keyed by a closed
 * `code`. It never interpolates a path, a byte, an offset or a file name, so a
 * caught error is always safe to log. Paths that failed verification travel
 * as data (`failures` on a tree verification), never inside the message.
 */

const NATIVE_ERROR_MESSAGES = {
  unsupported_target: 'Bundle target is not supported',
  invalid_node_version: 'Node version must be MAJOR.MINOR.PATCH',
  invalid_product_name: 'Sidecar product name is not a valid portable name',
  truncated: 'Native file is truncated or has an out-of-bounds offset',
  malformed: 'Native file header is malformed',
  unsupported_format: 'Native file format is not supported',
  read_limit: 'Native file inspection exceeded the read limit',
  read_failed: 'Native file could not be read',
  invalid_exception: 'Native exception pattern is not valid',
  verification_failed:
    'Bundle contains native files that do not match the target',
} as const;

/** Closed set of codes a `NativeVerificationError` can carry. */
export type NativeErrorCode = keyof typeof NATIVE_ERROR_MESSAGES;

/** One tree entry that failed verification (data, never in the message). */
export interface NativeFailure {
  readonly path: string;
  readonly reason: NativeFailureReason;
}

/** Why a file failed verification; a closed set. */
export type NativeFailureReason =
  | 'not_native'
  | 'wrong_format'
  | 'wrong_machine'
  | 'wrong_libc'
  | 'wrong_kind'
  | 'unsupported_format'
  | 'malformed'
  | 'truncated'
  | 'read_limit'
  | 'read_failed'
  | 'symlink'
  | 'special_file'
  | 'hardlinked'
  | 'invalid_path';

export class NativeVerificationError extends Error {
  readonly code: NativeErrorCode;
  /** Set only on `verification_failed`. */
  readonly failures: readonly NativeFailure[];

  constructor(code: NativeErrorCode, failures: readonly NativeFailure[] = []) {
    super(NATIVE_ERROR_MESSAGES[code]);
    this.name = 'NativeVerificationError';
    this.code = code;
    this.failures = Object.freeze([...failures]);
  }
}

/** The fixed message for `code`, exported for diagnostics and tests. */
export function nativeErrorMessage(code: NativeErrorCode): string {
  return NATIVE_ERROR_MESSAGES[code];
}
