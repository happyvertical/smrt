// The cloud profile's PostgreSQL for tenant apps, and its two credential sets
// (#5188). `DATABASE_URL` is the admin: the role the shell's own tables use,
// that owns the app schemas and runs schema work (the ownership claim, copies
// and swaps, boot and migration under `SET LOCAL ROLE <schema>_o`). When
// `SMRT_APP_SHELL_RUNTIME_DATABASE_URL` names a second login, user operations
// run as THAT login after `SET LOCAL ROLE <schema>_r` (broker.ts), and
// provisioning refuses to start an app on a login that is too powerful.
// Without it the deployment is single-owner (self-hosted): one login, no app
// roles, exactly as before.

import type { DatabaseConfig } from '../../engine/db/index.ts';
import {
  appRoles,
  assertRuntimeLogin,
  provisionAppRoles,
} from '../../engine/db/index.ts';
import type { ShellContext } from './host.ts';

type Provider = NonNullable<ShellContext['appDatabase']>;

/** What provisioning needs of a database connection. */
export interface SqlRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface CloudAppDatabaseOptions {
  /** The admin connection's URL (`DATABASE_URL`). */
  url: string;
  /** The runtime login's URL; absent: single-owner, no roles. */
  runtimeUrl?: string;
  /** Run `fn` on the admin connection. */
  admin: () => Promise<SqlRunner>;
  /**
   * Where the startup warning of a deployment without split credentials goes
   * (tests capture it). Default: one structured JSON line on stderr.
   */
  warn?: (entry: Record<string, unknown>) => void;
  /**
   * Run `check` as the runtime login on a connection of its own, closed after
   * (tests pass a stand-in). Default: a one-connection SDK handle on `runtimeUrl`.
   */
  asRuntime?: (
    url: string,
    check: (db: SqlRunner) => Promise<void>,
  ) => Promise<void>;
}

/** The login name in a PostgreSQL URL (decoded). */
export function loginOf(url: string): string {
  const name = decodeURIComponent(new URL(url).username);
  if (!name) throw new Error('the database URL names no login');
  return name;
}

async function sdkRuntime(
  url: string,
  check: (db: SqlRunner) => Promise<void>,
): Promise<void> {
  const { getDatabase } = await import('@happyvertical/sql');
  const raw: any = await getDatabase({
    type: 'postgres',
    url,
    max: 1,
    cache: false,
  } as never);
  try {
    await check({ query: (sql) => raw.query(sql) });
  } finally {
    await raw.close?.();
  }
}

function warnNoRoleIsolation(entry: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

/**
 * The provider for `ShellContext.appDatabase`: each app is one schema of the
 * server `url` names. `config` carries `max: 2` for a worker that has no shared
 * pool (`connection.max`); the hosted profile uses the process's one pool.
 */
export function cloudAppDatabase(options: CloudAppDatabaseOptions): Provider {
  const { url, runtimeUrl } = options;
  const split = runtimeUrl !== undefined && runtimeUrl !== url;
  const runtimeLogin = split ? loginOf(runtimeUrl) : undefined;
  // One login runs everything: the broker still scopes each operation to its
  // tenant (search_path, settings), but the database itself enforces nothing
  // between apps. Said once, loudly, at startup; the behaviour is unchanged.
  if (!split)
    (options.warn ?? warnNoRoleIsolation)({
      level: 'warn',
      event: 'app-shell.database.no-role-isolation',
      message:
        'no database-level role isolation: set SMRT_APP_SHELL_RUNTIME_DATABASE_URL to a separate unprivileged login',
      env: 'SMRT_APP_SHELL_RUNTIME_DATABASE_URL',
    });
  return {
    drop: async (schema) => {
      if (!/^app_[0-9a-f]{32}$/.test(schema))
        throw new Error('not an app schema name');
      await (await options.admin()).query(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
    },
    config: (schema): DatabaseConfig => ({
      kind: 'postgres',
      schema,
      connection: { url: split ? runtimeUrl : url, max: 2 },
      ...(split ? { admin: { url, max: 2 }, roles: appRoles(schema) } : {}),
    }),
    provision: async (schema) => {
      // The name is derived from two ids (`appSchemaName`); refuse anything else
      // before it is put in a statement.
      if (!/^app_[0-9a-f]{32}$/.test(schema))
        throw new Error('not an app schema name');
      const admin = await options.admin();
      await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      if (!split || !runtimeLogin) return;
      const adminLogin = String(
        (await admin.query('SELECT current_user AS name')).rows[0].name,
      );
      await provisionAppRoles(admin, schema, runtimeLogin, appRoles(schema), {
        ownerLogin: adminLogin,
      });
      // The login must hold no power of its own, and the roles must be what
      // provisioning made them: checked as the login, before the app serves.
      await (options.asRuntime ?? sdkRuntime)(runtimeUrl, (db) =>
        assertRuntimeLogin(db, [schema]),
      );
    },
  };
}
