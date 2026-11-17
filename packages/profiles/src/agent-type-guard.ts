/**
 * Guard for the `bot` profile type (#5086).
 *
 * The MCP principal kind is classified from the user's profile type, so a
 * principal that could move its own profile off the `bot` type (or rename the
 * `bot` type) would escape every kind-based control. Inside a request
 * principal context, a save that changes whether a profile is `bot` typed
 * (including one that adopts an existing row by natural key, and a create),
 * or that creates or renames a type to the `bot` slug, is refused unless the context is a
 * system or super-admin one. Code running with no principal context
 * (migrations, CLI, provisioning) is trusted as before.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { isSystemContext } from '@happyvertical/smrt-tenancy';

/** Slug of the profile type agent profiles are classified under. */
export const AGENT_PROFILE_TYPE_SLUG = 'bot';

interface RequestPermissionContext {
  systemContext?: boolean;
  superAdminBypass?: boolean;
}

/** The active request principal context, if any (installed by smrt-users). */
function principalContext(): RequestPermissionContext | undefined {
  const getter = (
    globalThis as {
      __smrtGetRequestPermissionContext?: () =>
        | RequestPermissionContext
        | undefined;
    }
  ).__smrtGetRequestPermissionContext;
  return typeof getter === 'function' ? getter() : undefined;
}

const trustedProvisioning = new AsyncLocalStorage<true>();

/**
 * Run framework agent provisioning (`resolveAgentProfile`) as trusted: it
 * creates `bot` profiles and the `bot` type on behalf of any caller, which
 * only ever yields the more restricted agent kind. Internal; not exported
 * from the package entry.
 */
export function withTrustedAgentProvisioning<T>(
  run: () => Promise<T>,
): Promise<T> {
  return trustedProvisioning.run(true, run);
}

/** True when a non-privileged request principal is acting. */
export function isUnprivilegedPrincipalContext(): boolean {
  if (trustedProvisioning.getStore()) return false;
  const context = principalContext();
  if (!context) return false;
  return !(
    context.systemContext === true ||
    context.superAdminBypass === true ||
    isSystemContext()
  );
}

/** Error thrown when a guarded `bot` type change is refused. */
export class AgentTypeChangeError extends Error {
  constructor() {
    super('The agent profile type cannot be changed by this principal.');
    this.name = 'AgentTypeChangeError';
  }
}
