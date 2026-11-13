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
  | 'schema_migration_refused'
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
