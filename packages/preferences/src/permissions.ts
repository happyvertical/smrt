import {
  type PermissionDefinition,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users';

/** Authorizes changing and resetting a tenant's default overview layouts. */
export const CUSTOMIZE_OVERVIEW_PERMISSION = 'overviews.customize';

/** Authorizes a principal to keep their own overview layouts. */
export const PERSONALIZE_OVERVIEW_PERMISSION = 'overviews.personalize';

/** Authorizes changing and resetting a tenant's default shell layout. */
export const CUSTOMIZE_SHELL_PERMISSION = 'shell.customize';

/** Authorizes a principal to keep their own shell layout and settings. */
export const PERSONALIZE_SHELL_PERMISSION = 'shell.personalize';

export const PREFERENCE_PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  {
    slug: CUSTOMIZE_OVERVIEW_PERMISSION,
    category: 'preferences',
    name: 'Customize Overviews',
    description:
      'Change the default overview layouts everyone in the tenant sees',
  },
  {
    slug: PERSONALIZE_OVERVIEW_PERMISSION,
    category: 'preferences',
    name: 'Personalize Overviews',
    description: 'Keep a personal overview layout on top of the tenant default',
  },
  {
    slug: CUSTOMIZE_SHELL_PERMISSION,
    category: 'preferences',
    name: 'Customize Shell Layout',
    description:
      'Change the default navigation and panel layout everyone in the tenant sees',
  },
  {
    slug: PERSONALIZE_SHELL_PERMISSION,
    category: 'preferences',
    name: 'Personalize Shell Layout',
    description:
      'Keep a personal navigation and panel layout on top of the tenant default',
  },
];

let registered = false;

/** Register the built-in preference permissions once. */
export function ensurePreferencePermissionsRegistered(): void {
  if (registered) {
    return;
  }
  registered = true;
  registerPermissionDefinitions(PREFERENCE_PERMISSION_DEFINITIONS);
}

/**
 * `collection.action` parts of a permission slug for the users operation
 * guards: the action is the last segment (`fields.policy.manage` is
 * collection `fields.policy`, action `manage`).
 */
export function splitPermissionSlug(slug: string): {
  collection: string;
  action: string;
} {
  const dot = slug.lastIndexOf('.');
  if (dot <= 0 || dot === slug.length - 1) {
    throw new Error(`Preference permission "${slug}" is not collection.action`);
  }
  return { collection: slug.slice(0, dot), action: slug.slice(dot + 1) };
}
