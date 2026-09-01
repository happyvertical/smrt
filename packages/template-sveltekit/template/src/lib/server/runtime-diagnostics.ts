import type { RuntimeDiagnostics } from '@happyvertical/smrt-app-runtime';
import type { Role } from '@happyvertical/smrt-users';
import { webMcpToolDefinitions } from '@happyvertical/smrt-virt-web';
import { json } from '@sveltejs/kit';

import { getCollection } from './smrt.js';
import { readApplicationRuntimeDiagnostics } from './application-runtime.js';
import { RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME } from '../runtime-diagnostics-webmcp.js';

export const RUNTIME_DIAGNOSTICS_READ_PERMISSION = 'runtime_diagnostics.read';

interface DiagnosticsLocals {
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

interface RuntimeDiagnosticsHandlerOptions {
  readonly resolveRoleSlug: (roleId: string) => Promise<string | null>;
  readonly readDiagnostics: () => Promise<RuntimeDiagnostics>;
}

/** Testable route boundary: authorization always completes before projection. */
export function createRuntimeDiagnosticsGet(
  options: RuntimeDiagnosticsHandlerOptions,
) {
  return async ({ locals }: { locals: DiagnosticsLocals }) => {
    const principal = authenticatedPrincipal(locals);
    if (!principal) {
      return stableError(401, 'authentication_required');
    }

    let authorized =
      locals.permissions?.includes(RUNTIME_DIAGNOSTICS_READ_PERMISSION) === true;
    if (!authorized) {
      try {
        authorized = (await options.resolveRoleSlug(principal.roleId)) === 'owner';
      } catch {
        authorized = false;
      }
    }
    if (!authorized) return stableError(403, 'authorization_denied');

    try {
      return json(await options.readDiagnostics());
    } catch {
      return stableError(503, 'diagnostics_unavailable');
    }
  };
}

export const runtimeDiagnosticsGet = createRuntimeDiagnosticsGet({
  async resolveRoleSlug(roleId) {
    const roles = await getCollection<Role>('Role');
    return (await roles.findById(roleId))?.slug ?? null;
  },
  readDiagnostics: () =>
    readApplicationRuntimeDiagnostics({
      toolNames: [
        ...webMcpToolDefinitions.map((definition) => definition.name),
        RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME,
      ],
      observedAt: new Date(),
      // Install application migration/schema verifiers here. Process/database
      // liveness alone intentionally leaves both values `unknown`.
      schemaStatus: 'unknown',
      migrationStatus: 'unknown',
      // External deployments install their lease-backed heartbeat adapter here.
      // Missing data remains `unknown`; web-process liveness is never substituted.
      workerHeartbeatAt: null,
      recentErrors: [],
    }),
});

function authenticatedPrincipal(locals: DiagnosticsLocals): {
  roleId: string;
} | null {
  const userId = locals.user?.id;
  const tenantId = locals.tenantId;
  const sessionId = locals.sessionId;
  const membership = locals.membership;
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

function stableError(status: number, code: string) {
  return json({ schemaVersion: 1, error: { code } }, { status });
}
