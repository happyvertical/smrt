/**
 * The public error contract (#5158): which error codes a caller may see, under
 * which HTTP status, with which text.
 *
 * This module imports nothing, so browser code and sibling packages can read
 * it through `@happyvertical/smrt-core/error-contract` without loading the
 * root entry. Keep it import-free.
 *
 * Matching is by the string `code` property and never by `instanceof`: a
 * second copy of this package, and classes that are plain `Error`s with a
 * `code` (smrt-tenancy's), must get the same answer.
 *
 * Nothing consults this table yet. It becomes the one answer when the
 * transport kernel's error path is switched on; until then each transport
 * keeps its own rendering.
 */

/**
 * How the public message of a coded error is chosen.
 *
 * - `fixed`: always {@link ErrorContractEntry.text}.
 * - `own`: the error's own `publicMessage` when it is a non-empty string,
 *   otherwise `text`.
 * - `field`: names the offending field when the caller may read that field,
 *   otherwise `text`. The value is never included.
 * - `opaque`: `text` plus a server-created reference; nothing from the error.
 */
export type ErrorMessageKind = 'fixed' | 'own' | 'field' | 'opaque';

export interface ErrorContractEntry {
  /** HTTP status. Non-HTTP surfaces report the same number. */
  readonly status: number;
  /** Status when the caller is anonymous, where that differs. */
  readonly anonymousStatus?: number;
  readonly message: ErrorMessageKind;
  /** The message, or the fallback when `message` is `own` or `field`. */
  readonly text: string;
}

const OPAQUE_500 = 'Internal server error';
const OPAQUE_502 = 'Upstream service error';
const OPAQUE_503 = 'Service unavailable';
const OPAQUE_504 = 'Upstream service timed out';
const RECORD_CHANGED = 'The record changed; reload and retry.';

const fixed = (status: number, text: string): ErrorContractEntry => ({
  status,
  message: 'fixed',
  text,
});
const own = (status: number, text: string): ErrorContractEntry => ({
  status,
  message: 'own',
  text,
});
const field = (text: string): ErrorContractEntry => ({
  status: 400,
  message: 'field',
  text,
});
const opaque = (status: 500 | 502 | 503 | 504 = 500): ErrorContractEntry => ({
  status,
  message: 'opaque',
  text:
    status === 502
      ? OPAQUE_502
      : status === 503
        ? OPAQUE_503
        : status === 504
          ? OPAQUE_504
          : OPAQUE_500,
});

const QUERY_REFUSED = 'The query is not valid.';

/**
 * Codes the kernel itself raises. Exported as constants so a typo is a
 * compile error rather than an unlisted code.
 */
export const TRANSPORT_ERROR_CODES = Object.freeze({
  REQUEST_MALFORMED: 'REQUEST_MALFORMED',
  REQUEST_TOO_LARGE: 'REQUEST_TOO_LARGE',
  REQUEST_UNSUPPORTED_MEDIA_TYPE: 'REQUEST_UNSUPPORTED_MEDIA_TYPE',
  VALIDATION_UNKNOWN_FIELD: 'VALIDATION_UNKNOWN_FIELD',
  VALIDATION_INVALID_ARGUMENT: 'VALIDATION_INVALID_ARGUMENT',
  QUERY_FIELD_NOT_ALLOWED: 'QUERY_FIELD_NOT_ALLOWED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  OPERATION_NOT_ALLOWED: 'OPERATION_NOT_ALLOWED',
  TENANT_CONTEXT_MISMATCH: 'TENANT_CONTEXT_MISMATCH',
} as const);

/**
 * Every error code this package can raise, and the transport kernel's own.
 *
 * One entry per code and no prefix rules: `error-contract.test.ts` fails when
 * a code exists in the sources without an entry, so adding a code means
 * deciding here what a caller is told.
 */
export const ERROR_CONTRACT: Readonly<Record<string, ErrorContractEntry>> =
  Object.freeze({
    // --- Request and transport (raised by the kernel) ---------------------
    REQUEST_MALFORMED: fixed(400, 'The request body is not valid JSON.'),
    REQUEST_TOO_LARGE: fixed(413, 'The request body is too large.'),
    REQUEST_UNSUPPORTED_MEDIA_TYPE: fixed(
      415,
      'The request body must be JSON.',
    ),
    VALIDATION_UNKNOWN_FIELD: own(
      400,
      'The request contains a field that is not accepted.',
    ),
    VALIDATION_INVALID_ARGUMENT: own(400, 'An argument is not valid.'),
    // One text for an unknown field and for one the caller may not read, so
    // the answer does not reveal which fields exist.
    QUERY_FIELD_NOT_ALLOWED: fixed(
      400,
      'A filter or sort field is not available.',
    ),
    AUTH_REQUIRED: fixed(401, 'Authentication required.'),
    PERMISSION_DENIED: fixed(403, 'Permission denied.'),
    NOT_FOUND: fixed(404, 'Not found.'),
    OPERATION_NOT_ALLOWED: fixed(405, 'Operation not allowed.'),

    // --- Tenant -----------------------------------------------------------
    TENANT_CONTEXT_MISMATCH: fixed(
      403,
      'Tenant context does not match the caller.',
    ),
    TENANT_ISOLATION_VIOLATION: fixed(403, 'Tenant access denied.'),
    TENANT_CONTEXT_REQUIRED: {
      status: 403,
      anonymousStatus: 401,
      message: 'fixed',
      text: 'Tenant context required.',
    },

    // --- Validation: the caller can correct the request -------------------
    VALIDATION_REQUIRED_FIELD: field('A required field is missing.'),
    VALIDATION_INVALID_VALUE: field('A field value is not valid.'),
    VALIDATION_RANGE_ERROR: field('A field value is out of range.'),
    VALIDATION_GENERATED_FIELD_WRITE: fixed(
      400,
      'A database-computed field cannot be written.',
    ),
    VALIDATION_ABSTRACT_MODEL: fixed(
      400,
      'This model cannot be saved directly.',
    ),
    VALIDATION_STI_REFERENCE_TYPE: fixed(
      400,
      'A referenced record is of the wrong type.',
    ),
    VALIDATION_STI_REFERENCE_TARGET_UNAVAILABLE: fixed(
      400,
      'A referenced record type is not available.',
    ),
    VALIDATION_CROSS_PACKAGE_REF_MISSING: fixed(
      400,
      'A referenced record does not exist.',
    ),
    VALIDATION_SYNC_METADATA: fixed(400, 'The sync metadata is not valid.'),

    // --- Queries: the class's own public message --------------------------
    INVALID_QUERY_BOUNDS: own(400, QUERY_REFUSED),
    INVALID_ORDER_BY: own(400, QUERY_REFUSED),
    INVALID_ORDER_BY_NOT_COLUMN_BACKED: own(400, QUERY_REFUSED),
    INVALID_ORDER_BY_RESTRICTED: own(400, QUERY_REFUSED),
    INVALID_ORDER_BY_SENSITIVE: own(400, QUERY_REFUSED),
    INVALID_ORDER_BY_UNKNOWN_FIELD: own(400, QUERY_REFUSED),
    INVALID_DATA_QUERY: own(400, QUERY_REFUSED),
    DATA_QUERY_FACET_NOT_ALLOWED: own(400, QUERY_REFUSED),
    DATA_QUERY_FIELD_NOT_ALLOWED: own(400, QUERY_REFUSED),
    DATA_QUERY_OPERATOR_NOT_ALLOWED: own(400, QUERY_REFUSED),
    DATA_QUERY_PROJECTION_NOT_ALLOWED: own(400, QUERY_REFUSED),
    DATA_QUERY_REQUEST_TOO_LARGE: own(400, QUERY_REFUSED),
    DATA_QUERY_RESULT_INVALID: own(400, QUERY_REFUSED),
    DATA_QUERY_RESULT_NOT_ALLOWED: own(400, QUERY_REFUSED),
    DATA_QUERY_RESULT_TOO_LARGE: own(400, QUERY_REFUSED),
    DATA_QUERY_SORT_NOT_ALLOWED: own(400, QUERY_REFUSED),
    DATA_QUERY_UNSUPPORTED: own(400, QUERY_REFUSED),
    DATA_QUERY_VALUE_NOT_ALLOWED: own(400, QUERY_REFUSED),

    // --- Conflicts. Never the colliding value. ----------------------------
    VALIDATION_UNIQUE_CONSTRAINT: fixed(
      409,
      'A record with these values already exists.',
    ),
    // Raised by delete integrity (a RESTRICT reference still points at the
    // row), not by a duplicate, so it has its own text.
    DB_CONSTRAINT_VIOLATION: fixed(
      409,
      'The change conflicts with related records.',
    ),
    RUNTIME_REVISION_CONFLICT: fixed(409, RECORD_CHANGED),
    RUNTIME_SYNC_REVISION_CONFLICT: fixed(409, RECORD_CHANGED),
    RUN_ONCE_IN_FLIGHT: fixed(
      409,
      'The same request is still in progress; retry shortly.',
    ),

    // --- Unavailable or upstream: opaque ----------------------------------
    RUNTIME_RESOURCE_EXHAUSTED: opaque(503),
    DB_CONNECTION_FAILED: opaque(503),
    NETWORK_SERVICE_UNAVAILABLE: opaque(503),
    AI_RATE_LIMIT: opaque(503),
    AI_PROVIDER_ERROR: opaque(502),
    AI_INVALID_RESPONSE: opaque(502),
    NETWORK_REQUEST_FAILED: opaque(502),
    NETWORK_TIMEOUT: opaque(504),

    // --- Server faults: opaque 500 ----------------------------------------
    // A provider credential failure is the server's, never the caller's: it
    // must not be reported as 401.
    AI_AUTH_FAILED: opaque(),
    DB_QUERY_FAILED: opaque(),
    DB_SCHEMA_ERROR: opaque(),
    DB_SCHEMA_MISSING: opaque(),
    DB_MIGRATION_REQUIRED: opaque(),
    DB_CORRUPTED_DATA: opaque(),
    DB_MISSING_DISCRIMINATOR: opaque(),
    DB_STI_DISCRIMINATOR_CONFLICT: opaque(),
    FS_FILE_NOT_FOUND: opaque(),
    FS_PERMISSION_DENIED: opaque(),
    FS_DISK_SPACE_EXCEEDED: opaque(),
    RUNTIME_INVALID_STATE: opaque(),
    RUNTIME_OPERATION_FAILED: opaque(),
    RUN_ONCE_OUTCOME_UNKNOWN: opaque(),
    MIGRATION_RETIRED_TABLE: opaque(),
    // Configuration faults in a generated expression or an unregistered
    // reference target: nothing the caller sent caused them.
    VALIDATION_GENERATED_EXPRESSION: opaque(),
    VALIDATION_GENERATED_DIALECT: opaque(),
    VALIDATION_GENERATED_NON_IMMUTABLE: opaque(),
    VALIDATION_CROSS_PACKAGE_REF_UNREGISTERED: opaque(),
    CONFIG_MISSING: opaque(),
    CONFIG_INVALID: opaque(),
    CONFIG_INIT_FAILED: opaque(),
    CONFIG_CIRCULAR_INHERITANCE: opaque(),
    CONFIG_INCOMPATIBLE_STRATEGY: opaque(),
    CONFIG_UNREGISTERED_BASE: opaque(),
    CONFIG_AMBIGUOUS_CLASS: opaque(),
    CONFIG_CALCULATED_FIELD_CLEARED: opaque(),
    CONFIG_COLLECTION_EXPOSURE: opaque(),
    CONFIG_INVALID_ISOLATED_MANIFEST: opaque(),
    CONFIG_INVALID_RUNTIME_OVERRIDE: opaque(),
    CONFIG_QUALIFIED_NAME_ALIAS_COLLISION: opaque(),
    CONFIG_QUALIFIED_NAME_ALIAS_INVALID: opaque(),
    CONFIG_REGISTRY_PROMOTION_COLLISION: opaque(),
    CONFIG_REQUIRED_FIELD_LOOSENED: opaque(),
    CONFIG_RETIRED_TABLE_INVALID: opaque(),
    CONFIG_STI_MIXED_SENSITIVITY: opaque(),
    CONFIG_STI_UNREGISTERED_PARENT: opaque(),
    CONFIG_SUBCLASS_EXPOSURE: opaque(),
    CONFIG_TABLE_MAPPING: opaque(),
    CONFIG_TABLE_MAPPING_CHANGED: opaque(),
    CONFIG_TABLE_NAME_COLLISION: opaque(),
    CONFIG_TENANT_MANIFEST_CONFLICT: opaque(),
    CONFIG_UNSCOPED_PACKAGE_NAME: opaque(),

    // --- AI runs, usage and inference -------------------------------------
    // Opaque until their owners decide a public answer: no generated
    // transport gives any of these a status today.
    AI_UNAVAILABLE: opaque(),
    AI_CALL_LIMIT: opaque(),
    AI_PROMPT_KEY_REQUIRED: opaque(),
    AI_EVALUATION_TENANT_MISMATCH: opaque(),
    AI_EVALUATION_UNKNOWN_TARGET: opaque(),
    AI_RUN_CHECKPOINT_CONFLICT: opaque(),
    AI_RUN_CLAIM_LOST: opaque(),
    AI_RUN_NOT_FOUND: opaque(),
    AI_RUN_RESUME_REFUSED: opaque(),
    AI_RUN_STOPPED: opaque(),
    AI_RUN_TOTALS_UNVERIFIABLE: opaque(),
    AI_RUN_TRACKING_DISABLED: opaque(),
    AI_RUN_TRANSITION_REFUSED: opaque(),
    AI_TRANSCRIPT_TENANT_REQUIRED: opaque(),
    AI_USAGE_TENANT_REQUIRED: opaque(),
    INFERENCE_TARGET_UNBOUND: opaque(),
  });

/** What an uncoded, unbranded failure is reported as. */
export const OPAQUE_ERROR: ErrorContractEntry = Object.freeze(opaque());

/** A code a caller may be shown: starts with a letter, at most 128 characters. */
const PUBLIC_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

const REGISTRY_SLOT = Symbol.for('smrt.errorContract');
const PUBLIC_ERROR_BRAND = Symbol.for('smrt.publicError');

type Registered = Map<string, ErrorContractEntry>;

/**
 * Codes added by other packages. Held on `globalThis` so two copies of this
 * module share one registry.
 */
function registered(): Registered {
  const holder = globalThis as unknown as Record<
    symbol,
    Registered | undefined
  >;
  let map = holder[REGISTRY_SLOT];
  if (!map) {
    map = new Map();
    holder[REGISTRY_SLOT] = map;
  }
  return map;
}

function assertEntry(code: string, entry: ErrorContractEntry): void {
  if (!PUBLIC_CODE_PATTERN.test(code)) {
    throw new TypeError(
      `Error code ${JSON.stringify(code)} is not a valid public code`,
    );
  }
  if (
    !entry ||
    !Number.isInteger(entry.status) ||
    entry.status < 400 ||
    entry.status > 599
  ) {
    throw new TypeError(
      `Error code ${code} needs an HTTP status from 400 to 599`,
    );
  }
  if (
    entry.anonymousStatus !== undefined &&
    (!Number.isInteger(entry.anonymousStatus) ||
      entry.anonymousStatus < 400 ||
      entry.anonymousStatus > 499)
  ) {
    throw new TypeError(`Error code ${code} has an invalid anonymous status`);
  }
  if (!['fixed', 'own', 'field', 'opaque'].includes(entry.message)) {
    throw new TypeError(`Error code ${code} has an unknown message kind`);
  }
  if (typeof entry.text !== 'string' || entry.text.length === 0) {
    throw new TypeError(`Error code ${code} needs a public text`);
  }
}

const sameEntry = (a: ErrorContractEntry, b: ErrorContractEntry): boolean =>
  a.status === b.status &&
  a.anonymousStatus === b.anonymousStatus &&
  a.message === b.message &&
  a.text === b.text;

/**
 * Add another package's error codes to the contract.
 *
 * Registration is idempotent: repeating an identical entry is accepted, so a
 * package loaded twice (two copies, a hot reload) does not fail. A code that
 * is already defined with a different entry is refused, as is any attempt to
 * redefine a code this package owns.
 *
 * @throws {TypeError} For a malformed code or entry, or a conflicting one.
 */
export function registerErrorCodes(
  entries: Readonly<Record<string, ErrorContractEntry>>,
): void {
  const map = registered();
  // Validate everything first so a refused call registers nothing.
  for (const [code, entry] of Object.entries(entries)) {
    assertEntry(code, entry);
    const existing = Object.hasOwn(ERROR_CONTRACT, code)
      ? ERROR_CONTRACT[code]
      : map.get(code);
    if (existing && !sameEntry(existing, entry)) {
      throw new TypeError(
        `Error code ${code} is already defined with a different contract`,
      );
    }
  }
  for (const [code, entry] of Object.entries(entries)) {
    if (Object.hasOwn(ERROR_CONTRACT, code)) continue;
    map.set(code, Object.freeze({ ...entry }));
  }
}

/** The contract entry for a code, or `undefined` when the code is not public. */
export function getErrorContract(
  code: unknown,
): ErrorContractEntry | undefined {
  if (typeof code !== 'string') return undefined;
  if (Object.hasOwn(ERROR_CONTRACT, code)) return ERROR_CONTRACT[code];
  return registered().get(code);
}

/** Every code with a contract: this package's, then registered ones. */
export function listErrorCodes(): string[] {
  return [...Object.keys(ERROR_CONTRACT), ...registered().keys()];
}

/** An error deliberately built to be shown to the caller. */
export interface PublicError extends Error {
  readonly status: number;
  readonly code: string;
  /** The message a transport may return verbatim. Same text as `message`. */
  readonly publicMessage: string;
}

/**
 * Build an error whose status, code and message are safe to return.
 *
 * Use it for a refusal the caller should understand (a locked record, a
 * policy limit). The result carries `status`, `code` and `publicMessage`, so
 * every existing transport already renders it; the kernel recognises it by a
 * cross-copy brand ({@link isPublicError}) rather than by those properties,
 * which third-party errors can also carry.
 *
 * @param status - HTTP status, 400 to 599.
 * @param code - Stable machine code. Need not be in the table.
 * @param message - Text shown to the caller. Never include stored values.
 * @throws {TypeError} For an out-of-range status, malformed code or empty message.
 */
export function publicError(
  status: number,
  code: string,
  message: string,
): PublicError {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new TypeError(
      'publicError status must be an integer from 400 to 599',
    );
  }
  if (typeof code !== 'string' || !PUBLIC_CODE_PATTERN.test(code)) {
    throw new TypeError('publicError code is not a valid public code');
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('publicError message must be a non-empty string');
  }
  const error = new Error(message) as Error & Record<string | symbol, unknown>;
  error.name = 'SmrtPublicError';
  error.status = status;
  error.code = code;
  error.publicMessage = message;
  Object.defineProperty(error, PUBLIC_ERROR_BRAND, { value: true });
  return error as unknown as PublicError;
}

/** True for an error built by {@link publicError}, in this or another copy of the package. */
export function isPublicError(error: unknown): error is PublicError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[PUBLIC_ERROR_BRAND] === true
  );
}
