/**
 * Request-scoped session permission context helpers
 * @packageDocumentation
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getPackageConfig } from '@happyvertical/smrt-config';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { Membership } from '../models/Membership.js';
import { PermissionResolver } from './PermissionResolver.js';
import {
  type SessionContext,
  SessionService,
  type SessionServiceOptions,
} from './SessionService.js';

interface QueryableDatabase extends DatabaseInterface {
  beginTransaction?: () => Promise<TransactionDatabase>;
  url: string;
}

interface TransactionDatabase extends QueryableDatabase {
  commit: () => Promise<void>;
  isActive: () => boolean;
  rollback: () => Promise<void>;
}

export interface SessionPermissionRuntimeContext {
  database?: QueryableDatabase;
  permissions: string[];
  permissionSet: Set<string>;
  membership: SessionContext['membership'];
  postgresRls: boolean;
  session: SessionContext | null;
  sessionId: string | null;
  superAdminBypass: boolean;
  systemContext: boolean;
  tenantId: string | null;
  user: SessionContext['user'] | null;
  userId: string | null;
}

export interface SessionPermissionRuntimeOptions extends SmrtClassOptions {
  enterTenantContext?: boolean;
  postgresRls?: boolean;
  sessionId?: string | null;
  sessionService?: SessionService;
  superAdminBypass?: boolean;
  systemContext?: boolean;
}

/**
 * Options for {@link withPrincipalPermissionContext}.
 *
 * Where {@link SessionPermissionRuntimeOptions} sources the principal from a
 * loaded session, this sources it directly from a `(userId, tenantId)` pair —
 * used to run work AS a bound principal (e.g. an agent persona's `runAsUserId`)
 * with that principal's *live* resolved permissions.
 */
export interface PrincipalPermissionRuntimeOptions extends SmrtClassOptions {
  /** Enter tenant context so tenant auto-filtering applies on every adapter. */
  enterTenantContext?: boolean;
  /**
   * Raw membership row for the `(userId, tenantId)` pair, forwarded to
   * {@link PermissionResolver.resolvePermissions}. Only consulted when
   * `permissions` is not supplied. Pass `null` to assert "no direct membership"
   * (enabling opt-in ancestor inheritance); leave `undefined` to let the
   * resolver look it up.
   */
  membership?: Membership | null;
  /**
   * Pre-resolved permission slugs. When omitted, the principal's permissions
   * are resolved LIVE via {@link PermissionResolver.resolvePermissions} so role
   * changes reflect on the next call.
   */
  permissions?: string[];
  /** Opt into Postgres RLS transaction wrapping (defaults to package config). */
  postgresRls?: boolean;
  /** Reuse an initialized resolver instead of creating one per call. */
  resolver?: PermissionResolver;
  /** Tenant the principal acts within. `null` resolves to no permissions. */
  tenantId: string | null;
  /** The user whose live permissions bound this execution. */
  userId: string;
}

/**
 * The controls shared by both permission-context entry points that influence
 * transaction wrapping and tenant-context entry.
 */
interface PermissionRuntimeControls {
  enterTenantContext?: boolean;
  postgresRls?: boolean;
  systemContext?: boolean;
}

type PermissionRuntimeDatabaseConfig =
  | SmrtClassOptions['db']
  | SmrtClassOptions['persistence'];

declare global {
  // eslint-disable-next-line no-var
  var __smrtGetRequestPermissionContext:
    | (() => SessionPermissionRuntimeContext | undefined)
    | undefined;
  // eslint-disable-next-line no-var
  var __smrtGetRequestScopedDatabase:
    | (() => QueryableDatabase | undefined)
    | undefined;
}

const requestPermissionContextStorage =
  new AsyncLocalStorage<SessionPermissionRuntimeContext>();

export function getCurrentSessionPermissionContext():
  | SessionPermissionRuntimeContext
  | undefined {
  return requestPermissionContextStorage.getStore();
}

export function getRequestScopedDatabase(): QueryableDatabase | undefined {
  return getCurrentSessionPermissionContext()?.database;
}

globalThis.__smrtGetRequestPermissionContext ??=
  getCurrentSessionPermissionContext;
globalThis.__smrtGetRequestScopedDatabase ??= getRequestScopedDatabase;

function isProbablyPostgres(
  configDb: SmrtClassOptions['db'],
  database: QueryableDatabase,
): boolean {
  if (
    configDb &&
    typeof configDb === 'object' &&
    !('query' in configDb) &&
    'type' in configDb &&
    configDb.type === 'postgres'
  ) {
    return true;
  }

  if (typeof database.url === 'string' && database.url.startsWith('postgres')) {
    return true;
  }

  return (database.constructor?.name || '').toLowerCase().includes('postgres');
}

async function setPostgresSessionVariables(
  database: QueryableDatabase,
  context: SessionPermissionRuntimeContext,
): Promise<void> {
  await database.query(
    "SELECT set_config('smrt.tenant_id', $1, true)",
    context.tenantId ?? '',
  );
  await database.query(
    "SELECT set_config('smrt.user_id', $1, true)",
    context.userId ?? '',
  );
  await database.query(
    "SELECT set_config('smrt.session_id', $1, true)",
    context.sessionId ?? '',
  );
  await database.query(
    "SELECT set_config('smrt.permissions', $1, true)",
    JSON.stringify(context.permissions),
  );
  await database.query(
    "SELECT set_config('smrt.super_admin_bypass', $1, true)",
    context.superAdminBypass ? 'true' : 'false',
  );
  await database.query(
    "SELECT set_config('smrt.system_context', $1, true)",
    context.systemContext ? 'true' : 'false',
  );
}

function isModuleNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' ||
      /Cannot find package '@happyvertical\/smrt-tenancy'/.test(error.message))
  );
}

async function runWithOptionalTenantContext<T>(
  controls: PermissionRuntimeControls,
  context: SessionPermissionRuntimeContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (controls.systemContext) {
    try {
      const tenancy = await import('@happyvertical/smrt-tenancy');
      return await tenancy.withSystemContext(fn);
    } catch (error) {
      if (isModuleNotFoundError(error)) {
        return await fn();
      }
      throw error;
    }
  }

  if (!controls.enterTenantContext || !context.tenantId) {
    return await fn();
  }

  try {
    const tenancy = await import('@happyvertical/smrt-tenancy');
    return await tenancy.withTenant(
      {
        database: context.database,
        permissions: context.permissionSet,
        superAdminBypass: context.superAdminBypass,
        tenantId: context.tenantId,
        user: context.user ?? undefined,
        userId: context.userId ?? undefined,
      },
      fn,
    );
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      return await fn();
    }
    throw error;
  }
}

/**
 * Shared runtime: given an already-resolved principal `spec` and the base
 * database, optionally open a Postgres RLS transaction, publish the principal
 * onto the DB session (`set_config(..., is_local=true)`), and run `fn` inside
 * the request-scoped ALS store (and optional tenant context).
 *
 * Both {@link withSessionPermissionContext} (principal from a loaded session)
 * and {@link withPrincipalPermissionContext} (principal from a `userId` +
 * live-resolved permissions) funnel through here, so the transaction lifecycle
 * and the exact DB-session publication stay identical no matter which door the
 * principal entered through.
 */
async function runWithinPermissionRuntime<T>(
  controls: PermissionRuntimeControls,
  configuredDb: PermissionRuntimeDatabaseConfig,
  baseDatabase: QueryableDatabase,
  spec: {
    permissions: string[];
    membership: SessionContext['membership'];
    session: SessionContext | null;
    sessionId: string | null;
    superAdminBypass: boolean;
    systemContext: boolean;
    tenantId: string | null;
    user: SessionContext['user'] | null;
    userId: string | null;
  },
  fn: (context: SessionPermissionRuntimeContext) => Promise<T>,
): Promise<T> {
  const config = getPackageConfig<{
    permissions?: { postgres?: { enabled?: boolean } };
  }>('users', {});
  const usePostgresRls =
    (controls.postgresRls ?? config.permissions?.postgres?.enabled ?? false) &&
    isProbablyPostgres(configuredDb, baseDatabase);

  let transaction: TransactionDatabase | undefined;
  let rolledBack = false;
  if (usePostgresRls) {
    if (!baseDatabase.beginTransaction) {
      throw new Error(
        'Postgres RLS requires a database adapter that supports beginTransaction().',
      );
    }
    transaction = await baseDatabase.beginTransaction();
  }

  const runtimeContext: SessionPermissionRuntimeContext = {
    database: transaction ?? baseDatabase,
    permissions: spec.permissions,
    permissionSet: new Set(spec.permissions),
    membership: spec.membership,
    postgresRls: usePostgresRls,
    session: spec.session,
    sessionId: spec.sessionId,
    superAdminBypass: spec.superAdminBypass,
    systemContext: spec.systemContext,
    tenantId: spec.tenantId,
    user: spec.user,
    userId: spec.userId,
  };

  try {
    if (transaction) {
      await setPostgresSessionVariables(transaction, runtimeContext);
    }

    return await requestPermissionContextStorage.run(runtimeContext, async () =>
      runWithOptionalTenantContext(controls, runtimeContext, () =>
        fn(runtimeContext),
      ),
    );
  } catch (error) {
    if (transaction) {
      const active = transaction.isActive ? transaction.isActive() : true;
      if (active) {
        rolledBack = true;
        await transaction.rollback();
      }
    }
    throw error;
  } finally {
    if (transaction && !rolledBack) {
      const active = transaction.isActive ? transaction.isActive() : true;
      if (active) {
        await transaction.commit();
      }
    }
  }
}

export async function withSessionPermissionContext<T>(
  options: SessionPermissionRuntimeOptions,
  fn: (context: SessionPermissionRuntimeContext) => Promise<T>,
): Promise<T> {
  const {
    enterTenantContext: _enterTenantContext,
    postgresRls: _postgresRls,
    sessionId: _sessionId,
    sessionService: _sessionService,
    superAdminBypass: _superAdminBypass,
    systemContext: _systemContext,
    ...sessionServiceOptions
  } = options;
  const sessionService =
    options.sessionService ??
    (await SessionService.create({
      ...sessionServiceOptions,
    } as SessionServiceOptions));
  const configuredDb =
    (sessionServiceOptions as SessionServiceOptions).db ??
    (sessionServiceOptions as SessionServiceOptions).persistence;
  const session =
    options.sessionId === undefined || options.sessionId === null
      ? null
      : await sessionService.loadSessionContext(options.sessionId);
  const baseDatabase = sessionService.getDatabase() as QueryableDatabase;

  return runWithinPermissionRuntime(
    {
      enterTenantContext: options.enterTenantContext,
      postgresRls: options.postgresRls,
      systemContext: options.systemContext,
    },
    configuredDb,
    baseDatabase,
    {
      permissions: session?.permissions ?? [],
      membership: session?.membership ?? null,
      session,
      sessionId: session?.sessionId ?? null,
      superAdminBypass: options.superAdminBypass ?? false,
      systemContext: options.systemContext ?? false,
      tenantId: session?.tenantId ?? null,
      user: session?.user ?? null,
      userId: session?.user.id ?? null,
    },
    fn,
  );
}

/**
 * Run `fn` AS a bound principal — a `(userId, tenantId)` pair rather than a
 * session — inside a session-permission context carrying that principal's
 * **live** resolved permissions.
 *
 * This is the door-agnostic mechanism behind "execute as principal": it does
 * NOT introduce a new authorization layer. It resolves the principal's
 * permissions through the standard {@link PermissionResolver} cascade (unless
 * the caller passes a pre-resolved set) and publishes `(smrt.user_id,
 * smrt.tenant_id, smrt.permissions[])` onto the DB session exactly like
 * {@link withSessionPermissionContext}, so the manifest-derived Postgres RLS
 * policies bound every query on that session per-`(table, action)`.
 *
 * A principal run never bypasses: `super_admin_bypass` and `system_context`
 * are always published as `false`. Resolution runs on the base connection
 * BEFORE any RLS transaction opens (identical ordering to session loading), so
 * the trusted cascade is never bounded by the not-yet-published principal.
 *
 * With RLS off (SQLite/dev) the same permission set is still resolved and
 * carried, but the DB has no per-operation teeth — callers relying on this on a
 * non-Postgres adapter must additionally assert the catalog permission for the
 * `(collection, action)` at their tool/exec seam (see
 * `assertOperationPermission`).
 */
export async function withPrincipalPermissionContext<T>(
  options: PrincipalPermissionRuntimeOptions,
  fn: (context: SessionPermissionRuntimeContext) => Promise<T>,
): Promise<T> {
  const {
    enterTenantContext: _enterTenantContext,
    membership,
    permissions: providedPermissions,
    postgresRls: _postgresRls,
    resolver: providedResolver,
    tenantId,
    userId,
    ...serviceOptions
  } = options;

  // Reuse SessionService purely as the blessed database accessor — no session
  // is loaded on this path; the principal comes straight from (userId,
  // tenantId).
  const sessionService = await SessionService.create({
    ...serviceOptions,
  } as SessionServiceOptions);
  const configuredDb =
    (serviceOptions as SessionServiceOptions).db ??
    (serviceOptions as SessionServiceOptions).persistence;
  const baseDatabase = sessionService.getDatabase() as QueryableDatabase;

  // Resolve the bound principal's LIVE permission set unless the caller passed
  // one explicitly. A missing tenant resolves to no permissions (fail closed).
  let permissions: string[];
  if (providedPermissions) {
    permissions = providedPermissions;
  } else if (tenantId) {
    const resolver =
      providedResolver ??
      (await PermissionResolver.create({
        ...serviceOptions,
      } as SmrtClassOptions));
    const resolved = await resolver.resolvePermissions(
      userId,
      tenantId,
      membership === undefined ? {} : { membership },
    );
    permissions = Array.from(resolved.permissions);
  } else {
    permissions = [];
  }

  return runWithinPermissionRuntime(
    {
      enterTenantContext: options.enterTenantContext,
      postgresRls: options.postgresRls,
      systemContext: false,
    },
    configuredDb,
    baseDatabase,
    {
      permissions,
      membership: null,
      session: null,
      sessionId: null,
      superAdminBypass: false,
      systemContext: false,
      tenantId: tenantId ?? null,
      user: null,
      userId,
    },
    fn,
  );
}
