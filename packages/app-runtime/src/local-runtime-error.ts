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
  /**
   * For an error with two readers (`schema_migration_refused`): one short line
   * the app may show its user, with no command or option in it. `message`
   * starts with it and adds the developer detail.
   */
  readonly userMessage?: string;
  /** What the app's developer needs: what stopped and what to change. */
  readonly developerDetail?: string;

  constructor(
    readonly code: LocalRuntimeErrorCode,
    message: string,
    audiences?: { userMessage: string; developerDetail: string },
  ) {
    super(message);
    if (audiences) {
      this.userMessage = audiences.userMessage;
      this.developerDetail = audiences.developerDetail;
    }
    this.name = 'LocalRuntimeError';
  }
}

export function unsafeFilesystemEntry(message: string, cause?: unknown) {
  const error = new LocalRuntimeError('invalid_configuration', message);
  if (cause !== undefined)
    Object.defineProperty(error, 'cause', { value: cause });
  return error;
}
