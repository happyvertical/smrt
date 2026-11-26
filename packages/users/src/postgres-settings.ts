/**
 * The six transaction-local `smrt.*` settings a PostgreSQL row-level-security
 * policy reads. Pure and dependency-free so a host that owns the connection
 * (a broker, a pool) can write them without loading the rest of the package.
 * Callers bind them with `set_config(name, value, true)`.
 * @packageDocumentation
 */

/** What the settings are derived from. */
export interface PostgresPrincipalSettingsInput {
  tenantId: string | null;
  userId: string | null;
  /** A loaded session; only then is its id published. */
  session: unknown | null;
  sessionId: string | null;
  permissions: readonly string[];
  superAdminBypass: boolean;
  systemContext: boolean;
}

/**
 * Value published to `smrt.session_id`. Only a session that was actually
 * loaded is published; an unverified label keeps it empty (fail closed).
 */
export function resolvePostgresSessionIdValue(
  context: Pick<PostgresPrincipalSettingsInput, 'session' | 'sessionId'>,
): string {
  return context.session ? (context.sessionId ?? '') : '';
}

/** `[name, value]` for each of the six `smrt.*` settings, in a fixed order. */
export function postgresPrincipalSettings(
  context: PostgresPrincipalSettingsInput,
): Array<[string, string]> {
  return [
    ['smrt.tenant_id', context.tenantId ?? ''],
    ['smrt.user_id', context.userId ?? ''],
    ['smrt.session_id', resolvePostgresSessionIdValue(context)],
    ['smrt.permissions', JSON.stringify(context.permissions)],
    ['smrt.super_admin_bypass', context.superAdminBypass ? 'true' : 'false'],
    ['smrt.system_context', context.systemContext ? 'true' : 'false'],
  ];
}
