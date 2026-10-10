import {
  type PermissionDefinition,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users';

/** The catalog collection both overview permissions belong to. */
export const OVERVIEW_PERMISSION_COLLECTION = 'overviews';

/** Authorizes writing and resetting a tenant's default overview layouts. */
export const CUSTOMIZE_OVERVIEW_PERMISSION = 'overviews.customize';

/** Authorizes a principal to keep their own overview layout override. */
export const PERSONALIZE_OVERVIEW_PERMISSION = 'overviews.personalize';

export const OVERVIEW_PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  {
    slug: CUSTOMIZE_OVERVIEW_PERMISSION,
    category: 'overviews',
    name: 'Customize Overviews',
    description:
      'Change the default overview layouts everyone in the tenant sees',
  },
  {
    slug: PERSONALIZE_OVERVIEW_PERMISSION,
    category: 'overviews',
    name: 'Personalize Overviews',
    description: 'Keep a personal overview layout on top of the tenant default',
  },
];

let registered = false;

/** Register the overview permissions once when smrt-overviews is loaded. */
export function ensureOverviewPermissionsRegistered(): void {
  if (registered) {
    return;
  }
  registered = true;
  registerPermissionDefinitions(OVERVIEW_PERMISSION_DEFINITIONS);
}
