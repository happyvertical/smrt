/**
 * Request-scoped session permission context helpers
 * @packageDocumentation
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getPackageConfig } from '@happyvertical/smrt-config';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
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
  options: SessionPermissionRuntimeOptions,
  context: SessionPermissionRuntimeContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (options.systemContext) {
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

  if (!options.enterTenantContext || !context.tenantId) {
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
  const permissionSet = new Set(session?.permissions ?? []);
  const baseDatabase = sessionService.getDatabase() as QueryableDatabase;
  const config = getPackageConfig<{
    permissions?: { postgres?: { enabled?: boolean } };
  }>('users', {});
  const usePostgresRls =
    (options.postgresRls ?? config.permissions?.postgres?.enabled ?? false) &&
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
    permissions: session?.permissions ?? [],
    permissionSet,
    membership: session?.membership ?? null,
    postgresRls: usePostgresRls,
    session,
    sessionId: session?.sessionId ?? null,
    superAdminBypass: options.superAdminBypass ?? false,
    systemContext: options.systemContext ?? false,
    tenantId: session?.tenantId ?? null,
    user: session?.user ?? null,
    userId: session?.user.id ?? null,
  };

  try {
    if (transaction) {
      await setPostgresSessionVariables(transaction, runtimeContext);
    }

    return await requestPermissionContextStorage.run(runtimeContext, async () =>
      runWithOptionalTenantContext(options, runtimeContext, () =>
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
