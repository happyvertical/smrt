/**
 * Mountable runtime routes: liveness health, authorized diagnostics, and the
 * server-owned session summary for the root layout.
 */

import {
  getRequestScopedDatabase,
  RoleCollection,
} from '@happyvertical/smrt-users';
import { json, type RequestHandler } from '@sveltejs/kit';
import type { RuntimeDiagnostics } from '../runtime-diagnostics.js';
import type {
  ApplicationRuntimeDiagnosticsOptions,
  SmrtSvelteKitRuntime,
} from './runtime.js';

/** Explicit permission that grants diagnostics read without the owner role. */
export const RUNTIME_DIAGNOSTICS_READ_PERMISSION = 'runtime_diagnostics.read';

/**
 * Mount as `src/routes/api/_runtime/health/+server.ts`:
 * `export const GET = createRuntimeHealthHandler(runtime);`
 *
 * Local responses add the application ID, managed process instance, and the
 * secret-free configuration fingerprint that process managers compare.
 * Deployed responses expose only schema version, status, and profile.
 */
export function createRuntimeHealthHandler(
  runtime: Pick<SmrtSvelteKitRuntime, 'health'>,
): RequestHandler {
  return async () => json(await runtime.health());
}

/** The locals the diagnostics route authorizes against. */
export interface DiagnosticsPrincipalLocals {
  readonly user?: { readonly id?: unknown } | null;
  readonly membership?: {
    readonly userId?: unknown;
    readonly tenantId?: unknown;
    readonly roleId?: unknown;
    isActive?: () => boolean;
  } | null;
  readonly permissions?: readonly string[];
  readonly tenantId?: unknown;
  readonly sessionId?: unknown;
}

type DiagnosticsInputValue<T> = T | (() => T);

export interface RuntimeDiagnosticsHandlerOptions {
  /** Supplies default diagnostics reading and owner-role lookup. */
  readonly runtime?: Pick<
    SmrtSvelteKitRuntime,
    'readDiagnostics' | 'classOptions'
  >;
  /** Replace the runtime projection (must already be the public allowlist). */
  readonly readDiagnostics?: () => Promise<RuntimeDiagnostics>;
  /** Replace the owner-role lookup. Thrown errors deny. */
  readonly resolveRoleSlug?: (roleId: string) => Promise<string | null>;
  /** Override where the principal comes from. Defaults to `event.locals`. */
  readonly resolveLocals?: (event: {
    readonly locals: unknown;
  }) => DiagnosticsPrincipalLocals;
  /** Public tool inventory (sorted/capped by the projector). */
  readonly toolNames?: DiagnosticsInputValue<readonly string[]>;
  readonly schemaStatus?: DiagnosticsInputValue<
    ApplicationRuntimeDiagnosticsOptions['schemaStatus']
  >;
  readonly migrationStatus?: DiagnosticsInputValue<
    ApplicationRuntimeDiagnosticsOptions['migrationStatus']
  >;
  readonly workerHeartbeatAt?: () => Date | string | null | undefined;
  readonly recentErrors?: () => ApplicationRuntimeDiagnosticsOptions['recentErrors'];
  /** Testable clock. */
  readonly now?: () => Date;
}

function resolveInputValue<T>(
  value: DiagnosticsInputValue<T> | undefined,
): T | undefined {
  return typeof value === 'function' ? (value as () => T)() : value;
}

/**
 * Mount as `src/routes/api/_runtime/diagnostics/+server.ts`:
 * `export const GET = createRuntimeDiagnosticsHandler({ runtime });`
 *
 * Authentication and authorization always complete before the private runtime
 * is read. Authorized callers hold `runtime_diagnostics.read` or the `owner`
 * role of their active, session-matching membership. Every failure is a
 * stable `{ schemaVersion: 1, error: { code } }` body.
 */
export function createRuntimeDiagnosticsHandler(
  options: RuntimeDiagnosticsHandlerOptions,
): RequestHandler {
  const runtime = options.runtime;
  const readDiagnostics =
    options.readDiagnostics ??
    (runtime
      ? () =>
          runtime.readDiagnostics({
            toolNames: resolveInputValue(options.toolNames) ?? [],
            observedAt: options.now?.() ?? new Date(),
            schemaStatus: resolveInputValue(options.schemaStatus) ?? 'unknown',
            migrationStatus:
              resolveInputValue(options.migrationStatus) ?? 'unknown',
            workerHeartbeatAt: options.workerHeartbeatAt?.() ?? null,
            recentErrors: options.recentErrors?.() ?? [],
          })
      : undefined);
  const resolveRoleSlug =
    options.resolveRoleSlug ??
    (runtime
      ? async (roleId: string) => {
          const config = runtime.classOptions('Role');
          const requestDb = getRequestScopedDatabase();
          const roles = await RoleCollection.create(
            requestDb
              ? { ...config, db: requestDb as typeof config.db }
              : config,
          );
          return (await roles.findById(roleId))?.slug ?? null;
        }
      : undefined);
  if (!readDiagnostics || !resolveRoleSlug) {
    throw new TypeError(
      'createRuntimeDiagnosticsHandler requires `runtime`, or both `readDiagnostics` and `resolveRoleSlug`.',
    );
  }
  const resolveLocals =
    options.resolveLocals ??
    ((event: { readonly locals: unknown }) =>
      event.locals as DiagnosticsPrincipalLocals);

  return async (event) => {
    const locals = resolveLocals(event);
    const principal = authenticatedPrincipal(locals);
    if (!principal) return stableError(401, 'authentication_required');

    let authorized =
      locals.permissions?.includes(RUNTIME_DIAGNOSTICS_READ_PERMISSION) ===
      true;
    if (!authorized) {
      try {
        authorized = (await resolveRoleSlug(principal.roleId)) === 'owner';
      } catch {
        authorized = false;
      }
    }
    if (!authorized) return stableError(403, 'authorization_denied');

    try {
      return json(await readDiagnostics());
    } catch {
      return stableError(503, 'diagnostics_unavailable');
    }
  };
}

function authenticatedPrincipal(
  locals: DiagnosticsPrincipalLocals | null | undefined,
): { roleId: string } | null {
  const userId = locals?.user?.id;
  const tenantId = locals?.tenantId;
  const sessionId = locals?.sessionId;
  const membership = locals?.membership;
  if (
    typeof userId !== 'string' ||
    !userId ||
    typeof tenantId !== 'string' ||
    !tenantId ||
    typeof sessionId !== 'string' ||
    !sessionId ||
    !membership ||
    membership.userId !== userId ||
    membership.tenantId !== tenantId ||
    typeof membership.roleId !== 'string' ||
    !membership.roleId
  ) {
    return null;
  }
  try {
    if (membership.isActive?.() !== true) return null;
  } catch {
    return null;
  }
  return { roleId: membership.roleId };
}

function stableError(status: number, code: string): Response {
  return json({ schemaVersion: 1, error: { code } }, { status });
}

/** Server-owned session summary for the root layout. */
export interface SessionLayoutData {
  readonly session: {
    readonly authenticated: boolean;
    /** Tenant authorized by the active session. */
    readonly activeTenantId: string | null;
    /** URL-selected tenant candidate; display only, never authorization. */
    readonly selectedTenantSlug: string | null;
  };
}

/**
 * Mount as `src/routes/+layout.server.ts`:
 * `export const load = createSessionLayoutLoad();`
 */
export function createSessionLayoutLoad(): (event: {
  readonly locals: unknown;
}) => SessionLayoutData {
  return ({ locals }) => {
    const value = locals as {
      user?: unknown;
      tenantId?: string | null;
      selectedTenantSlug?: string | null;
    };
    return {
      session: {
        authenticated: Boolean(value.user),
        activeTenantId: value.tenantId ?? null,
        selectedTenantSlug: value.selectedTenantSlug ?? null,
      },
    };
  };
}
