/**
 * Guard for the `bot` profile type (#5086).
 *
 * The MCP principal kind is classified from the user's profile type, so a
 * principal that could move its own profile off the `bot` type (or rename the
 * `bot` type) would escape every kind-based control. Inside a request
 * principal context, changing an existing profile's type to or from `bot`,
 * or changing the `bot` type's slug, is refused unless the context is a
 * system or super-admin one. Code running with no principal context
 * (migrations, CLI, provisioning) is trusted as before.
 *
 * @module
 */

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

/** True when a non-privileged request principal is acting. */
export function isUnprivilegedPrincipalContext(): boolean {
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
