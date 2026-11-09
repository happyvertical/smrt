/**
 * One error type for every desktop contract artifact.
 *
 * The message is fixed text keyed by `code`. It never interpolates a path, an
 * origin, a pid, a key or a secret, so a caught error is always safe to log or
 * show. Callers branch on `code`; `field` names a schema field (never a value)
 * when a document field was the cause.
 *
 * The public code union is derived from the table below, so adding a code
 * means adding a table row and nothing else.
 */

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

const ERROR_MESSAGES = INSTALL_ERROR_MESSAGES;

/** Closed set of codes for contract (a), the installed-product bundle. */
export type InstallErrorCode = keyof typeof INSTALL_ERROR_MESSAGES;

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
