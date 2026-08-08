import {
  type PermissionDefinition,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users';

/** Authorizes app- and tenant-scope field-policy administration. */
export const MANAGE_FIELD_POLICY_PERMISSION = 'fields.policy.manage';

/** Authorizes a principal to maintain their own user-scope field policy. */
export const PERSONALIZE_FIELD_POLICY_PERMISSION = 'fields.policy.personalize';

export const FIELD_POLICY_PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  {
    slug: MANAGE_FIELD_POLICY_PERMISSION,
    category: 'fields',
    name: 'Manage Field Policies',
    description: 'Manage application and tenant field-policy overrides',
  },
  {
    slug: PERSONALIZE_FIELD_POLICY_PERMISSION,
    category: 'fields',
    name: 'Personalize Field Policies',
    description: 'Manage the caller’s own field-policy overrides',
  },
];

let registered = false;

/** Register field-policy permissions once when smrt-fields is loaded. */
export function ensureFieldPolicyPermissionsRegistered(): void {
  if (registered) {
    return;
  }
  registered = true;
  registerPermissionDefinitions(FIELD_POLICY_PERMISSION_DEFINITIONS);
}
