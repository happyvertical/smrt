/** Explicit bounded-read permission independent of the deliberately closed generated expense surface. */
import {
  type PermissionDefinition,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users';
/** Hosts grant this real catalog permission alongside their project cost visibility policy. */
export const EXPENSE_ALLOCATION_PERMISSION_DEFINITIONS: PermissionDefinition[] =
  [
    {
      slug: 'expenses.read',
      name: 'Read allocated expense portions',
      description:
        'Read bounded expense allocation portions through current host target authority; does not expose original expense or receipt records.',
      category: 'accounting',
    },
  ];
registerPermissionDefinitions(EXPENSE_ALLOCATION_PERMISSION_DEFINITIONS);
