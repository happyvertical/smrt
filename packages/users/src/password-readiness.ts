/**
 * Readiness contract for the public self-hosted password provider.
 *
 * This is intentionally a provider module for app-runtime's generic
 * `createProviderReadinessProbe`: operators select it with
 * `SMRT_AUTH_READINESS_MODULE=@happyvertical/smrt-users`.  It proves the
 * configured PostgreSQL database has the rows password sign-in actually uses;
 * it never creates or repairs application schema.
 */

import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  DEFAULT_PASSWORD_MAX_LENGTH,
  DEFAULT_PASSWORD_MIN_LENGTH,
} from './services/PasswordCredentialService.js';

export interface PasswordReadinessContext {
  component: string;
  profile: string;
  provider: string;
}

const REQUIRED_COLUMNS: readonly string[] = [
  'users.email_key',
  'users.username_key',
  'users.status',
  'memberships.user_id',
  'memberships.tenant_id',
  'memberships.role_id',
  'memberships.status',
  'sessions.id',
  'sessions.user_id',
  'sessions.tenant_id',
  'sessions.status',
  'sessions.expires_at',
  'sessions.auth_method',
  'sessions.parent_session_id',
  'users_password_credentials.user_id',
  'users_password_credentials.password_hash',
  'users_password_credentials.version',
  'users_password_credentials.must_change',
  'users_password_credentials.rotated_at',
  'users_password_credentials.rotated_by',
  'users_login_attempts.id',
  'users_login_audit_events.id',
];

const REQUIRED_TABLES = new Set(
  REQUIRED_COLUMNS.map((column) => column.split('.')[0]),
);

function assertProviderContext(context: PasswordReadinessContext): void {
  if (
    context.component !== 'authentication' ||
    context.profile !== 'self-hosted' ||
    context.provider !== 'password'
  ) {
    throw new Error(
      'Password readiness is only valid for self-hosted authentication.',
    );
  }
}

function configuredPostgresUrl(environment: NodeJS.ProcessEnv): string {
  const value = environment.DATABASE_URL;
  if (!value)
    throw new Error('DATABASE_URL is required for password readiness.');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must be a PostgreSQL URL.');
  }
  return value;
}

async function requirePasswordSchema(db: DatabaseInterface): Promise<void> {
  const result = await db.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('users', 'memberships', 'sessions',
                           'users_password_credentials',
                           'users_login_attempts', 'users_login_audit_events')`,
  );
  const found = new Set<string>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const table = row.table_name;
    const column = row.column_name;
    if (typeof table === 'string' && typeof column === 'string') {
      found.add(`${table}.${column}`);
    }
  }
  const missing = REQUIRED_COLUMNS.filter((column) => !found.has(column));
  const missingTables = [...REQUIRED_TABLES].filter(
    (table) => ![...found].some((column) => column.startsWith(`${table}.`)),
  );
  if (missing.length || missingTables.length) {
    throw new Error('Password authentication schema is not ready.');
  }
}

/**
 * Provider readiness entry point.  Errors are intentionally generic because
 * app-runtime projects provider failures into public-safe startup diagnostics.
 */
export async function checkReadiness(
  context: PasswordReadinessContext,
): Promise<true> {
  assertProviderContext(context);
  // These constants are part of the password service's executable policy;
  // keep readiness coupled to a bounded policy rather than accepting a
  // configuration-only password selector.
  if (
    DEFAULT_PASSWORD_MIN_LENGTH < 10 ||
    DEFAULT_PASSWORD_MAX_LENGTH < DEFAULT_PASSWORD_MIN_LENGTH
  ) {
    throw new Error('Password policy is not ready.');
  }
  const db = await getDatabase({
    type: 'postgres',
    url: configuredPostgresUrl(process.env),
    // Readiness owns this connection and closes it; never borrow the
    // application's cached handle during a live readiness check.
    cache: false,
  });
  try {
    await requirePasswordSchema(db);
    return true;
  } finally {
    await db.close?.();
  }
}
