/**
 * One error type for every desktop contract artifact.
 *
 * The message is fixed text keyed by `code`. It never interpolates a path, an
 * origin, a pid, a key or a secret, so a caught error is always safe to log or
 * show. Callers branch on `code`; `field` names a schema field (never a value)
 * when a document field was the cause.
 *
 * Each contract owns one `*_ERROR_MESSAGES` table below. The public code union
 * is derived from the tables, so adding a code means adding a table row and
 * nothing else.
 */

/** Codes shared by the foundations (`SecretString`, grammars, locations). */
const COMMON_ERROR_MESSAGES = {
  invalid_secret: 'Secret value must be a non-empty string without NUL',
} as const;

/** Contract (a): the installed-product bundle (`smrt-bundle.json`, etc.). */
const INSTALL_ERROR_MESSAGES = {
  not_installed:
    'Desktop product is not installed or has not been started on this machine',
  unsupported_contract: 'Desktop contract version is not supported',
  identity_mismatch:
    'Installed desktop product does not match the expected identity or version',
  untrusted_path: 'Desktop installation failed the filesystem trust checks',
  invalid_json: 'Desktop contract document must be valid JSON',
  duplicate_keys: 'Desktop contract document must not repeat object keys',
  invalid_document:
    'Desktop contract document must be an object with exactly the documented fields',
  invalid_field: 'Desktop contract document has an invalid field',
  sidecar_mismatch:
    'Bundle manifest does not match the sidecar manifest it names',
  invalid_environment:
    'Desktop location environment is missing or not an absolute path',
  unsupported_platform: 'Desktop platform is not supported',
} as const;

/**
 * Contract (b): the supervisor rendezvous (`instance.json` and the control
 * channel). Document-level failures reuse the shared `invalid_json`,
 * `duplicate_keys`, `invalid_document`, `invalid_field` and
 * `unsupported_contract` codes above.
 */
const RENDEZVOUS_ERROR_MESSAGES = {
  invalid_control_message:
    'Control channel message must be a single JSON object with exactly the documented fields',
  control_message_too_large: 'Control channel message exceeds the size limit',
  unsupported_op: 'Control channel operation is not supported',
  invalid_endpoint: 'Control channel endpoint is not valid',
  untrusted_endpoint: 'Control channel endpoint failed the trust checks',
  control_unreachable: 'Control channel could not be reached',
  control_timeout: 'Control channel did not answer in time',
  control_aborted: 'Control channel request was aborted',
  control_server_failed: 'Control channel server could not be started',
} as const;

const ERROR_MESSAGES = {
  ...COMMON_ERROR_MESSAGES,
  ...INSTALL_ERROR_MESSAGES,
  ...RENDEZVOUS_ERROR_MESSAGES,
} as const;

/** Closed set of codes for contract (a), the installed-product bundle. */
export type InstallErrorCode = keyof typeof INSTALL_ERROR_MESSAGES;

/** Closed set of codes for contract (b), the supervisor rendezvous. */
export type RendezvousErrorCode = keyof typeof RENDEZVOUS_ERROR_MESSAGES;

/** Every code a `DesktopContractError` can carry. */
export type DesktopContractErrorCode = keyof typeof ERROR_MESSAGES;

/** Optional detail for a `DesktopContractError`; never carries input values. */
export interface DesktopContractErrorOptions {
  /** Static schema field name (for example `bridge.entry`), never a value. */
  readonly field?: string;
}

export class DesktopContractError extends Error {
  readonly code: DesktopContractErrorCode;
  readonly field?: string;

  constructor(
    code: DesktopContractErrorCode,
    options: DesktopContractErrorOptions = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'DesktopContractError';
    this.code = code;
    if (options.field !== undefined) this.field = options.field;
  }
}

/** The fixed message for `code`, exported for diagnostics and tests. */
export function desktopContractErrorMessage(
  code: DesktopContractErrorCode,
): string {
  return ERROR_MESSAGES[code];
}
