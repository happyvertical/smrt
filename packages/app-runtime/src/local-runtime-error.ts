/**
 * Stable, secret-free failure type of the local runtime and its custody
 * checks. Kept in its own module so the custody code and the public entry
 * point share one class identity without importing each other.
 */

export type LocalRuntimeErrorCode =
  | 'bootstrap_claimed'
  | 'bootstrap_expired'
  | 'bootstrap_invalid'
  | 'bootstrap_unavailable'
  | 'capability_disabled'
  | 'invalid_configuration'
  | 'installation_seed_missing'
  | 'installation_unverified'
  | 'invalid_scope'
  | 'migration_failed'
  | 'owner_tenant_conflict'
  | 'owner_identity_conflict'
  | 'owner_unavailable'
  | 'schema_creation_failed'
  | 'unsafe_public_exposure';

/** Stable, secret-free local-runtime failure. */
export class LocalRuntimeError extends Error {
  constructor(
    readonly code: LocalRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocalRuntimeError';
  }
}

export function unsafeFilesystemEntry(message: string, cause?: unknown) {
  const error = new LocalRuntimeError('invalid_configuration', message);
  if (cause !== undefined)
    Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

/** Fixed, secret-free message of {@link WindowsDatabaseAcquisitionUnsupportedError}. */
export const WINDOWS_DATABASE_ACQUISITION_UNSUPPORTED_MESSAGE =
  'Secure local database acquisition is not supported on Windows yet: @happyvertical/sql has no caller-supplied Windows custody verifier for its secure SQLite path (smrt#4837). The runtime refused before it created or opened any database, data root, marker or lease; anything the calling program prepared earlier is outside this check (the smrt app commands refuse the local profile on Windows before they create anything). Read-only storage validation and the self-hosted and cloud profiles are unaffected.';

/**
 * Raised when a local runtime would have to open its SQLite database on
 * Windows. The runtime entry points throw it before they create or open
 * anything themselves, but a caller may already have created files of its
 * own (the `smrt app` commands therefore refuse the local profile on Windows
 * earlier still). The Windows custody rule is implemented for the leases, the
 * operator state root, and read-only validation; opening the database stays
 * refused until the SDK accepts a Windows verifier.
 */
export class WindowsDatabaseAcquisitionUnsupportedError extends LocalRuntimeError {
  readonly reason = 'windows_secure_sqlite_unsupported' as const;

  constructor() {
    super(
      'invalid_configuration',
      WINDOWS_DATABASE_ACQUISITION_UNSUPPORTED_MESSAGE,
    );
    this.name = 'WindowsDatabaseAcquisitionUnsupportedError';
  }
}
