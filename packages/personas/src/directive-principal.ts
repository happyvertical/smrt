/**
 * The permission split that gates persona directive activation (#1889).
 *
 * **The gate is the permission system, not a bespoke subsystem.** Activating a
 * directive — writing/enabling the persona-scoped `prompt_override` — is a
 * permissioned operation guarded by the `personas.activate-directive` slug. The
 * autonomous reflection principal runs *without* that permission, so it can only
 * propose; a human who holds it approves / edits / rejects. Confidence-only
 * reinforcement stays automatic; only instruction rewrites are gated.
 *
 * This module contributes the slug to the manifest-derived permission catalog
 * (via `registerPermissionDefinitions`) and provides a small
 * {@link DirectivePrincipal} abstraction over "which permission slugs does this
 * actor hold". In production the principal is built from a
 * `PermissionResolver.resolvePermissions()` result; tests inject one directly.
 *
 * @module
 */

import {
  type PermissionDefinition,
  type PermissionResolver,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users';

/** The permission slug that authorises activating a persona directive. */
export const ACTIVATE_DIRECTIVE_PERMISSION = 'personas.activate-directive';

/** Catalog definition contributed for {@link ACTIVATE_DIRECTIVE_PERMISSION}. */
export const DIRECTIVE_ACTIVATION_PERMISSION_DEF: PermissionDefinition = {
  slug: ACTIVATE_DIRECTIVE_PERMISSION,
  category: 'personas',
  name: 'Activate Persona Directive',
  description:
    "Approve, edit, or reject a proposed edit to a persona's instructions and activate the persona-scoped prompt override",
};

/**
 * An actor whose authority is expressed as a set of held permission slugs.
 *
 * Deliberately minimal so the gate depends only on the permission model, not on
 * any particular resolver or session machinery.
 */
export interface DirectivePrincipal {
  /** Optional stable id (recorded as the reviewer on approve/reject). */
  readonly id?: string;
  /** Whether this actor holds the given permission slug. */
  can(slug: string): boolean;
}

/**
 * Build a {@link DirectivePrincipal} from an explicit set of granted slugs.
 */
export function principalFromPermissions(
  permissions: Iterable<string>,
  options: { id?: string } = {},
): DirectivePrincipal {
  const granted = new Set(permissions);
  return {
    id: options.id,
    can: (slug: string) => granted.has(slug),
  };
}

/**
 * Build a {@link DirectivePrincipal} for a user in a tenant by resolving their
 * effective permissions through the RBAC {@link PermissionResolver} — the
 * production wiring that makes the gate concretely the permission system.
 */
export async function resolveDirectivePrincipal(options: {
  resolver: PermissionResolver;
  userId: string;
  tenantId: string;
}): Promise<DirectivePrincipal> {
  const { permissions } = await options.resolver.resolvePermissions(
    options.userId,
    options.tenantId,
  );
  return principalFromPermissions(permissions, { id: options.userId });
}

let personaPermissionsRegistered = false;

/**
 * Register the persona directive-activation permission into the runtime catalog.
 *
 * @returns An unregister function (primarily for tests).
 */
export function registerPersonaPermissions(): () => void {
  return registerPermissionDefinitions([DIRECTIVE_ACTIVATION_PERMISSION_DEF]);
}

/**
 * Register the persona permissions once per process. Called as a side effect
 * from the package entry so the slug is present in the permission catalog for
 * any consumer that imports `@happyvertical/smrt-personas`.
 */
export function ensurePersonaPermissionsRegistered(): void {
  if (personaPermissionsRegistered) {
    return;
  }
  personaPermissionsRegistered = true;
  registerPersonaPermissions();
}
