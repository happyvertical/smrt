import { assertOperationPermission } from '@happyvertical/smrt-users';
import { fail } from '@sveltejs/kit';

import type { Item } from '$lib/objects/Item';
import { getCollection, getSmrtConfig } from '$lib/server/smrt';
import type { Actions, PageServerLoad } from './$types';

const READ_PERMISSION = 'items.read';
const CREATE_PERMISSION = 'items.create';

export interface ItemRow {
  id: string;
  title: string;
  status: string;
}

export const load: PageServerLoad = async ({ depends, locals }) => {
  depends('smrt:items');

  const authenticated = Boolean(locals.user);
  const hasTenant = Boolean(locals.tenantId);
  const canRead =
    authenticated && hasTenant && locals.permissions.includes(READ_PERMISSION);
  const canCreate =
    authenticated && hasTenant && locals.permissions.includes(CREATE_PERMISSION);

  if (!canRead) {
    return {
      items: [] as ItemRow[],
      canCreate,
      loadError: null as string | null,
      accessMessage: !authenticated
        ? 'Sign in before loading tenant data.'
        : !hasTenant
          ? 'Select a tenant through a membership-gated session switch.'
          : `Your active role does not grant ${READ_PERMISSION}.`,
    };
  }

  try {
    const items = await getCollection<Item>('Item');
    const rows = await items.list({
      orderBy: 'created_at DESC',
      limit: 50,
    });

    return {
      items: rows.flatMap((item): ItemRow[] =>
        item.id
          ? [{ id: item.id, title: item.title, status: item.status }]
          : [],
      ),
      canCreate,
      loadError: null as string | null,
      accessMessage: null as string | null,
    };
  } catch (error) {
    return {
      items: [] as ItemRow[],
      canCreate,
      loadError:
        error instanceof Error ? error.message : 'Failed to load items',
      accessMessage: null as string | null,
    };
  }
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    if (!locals.user?.id || !locals.tenantId) {
      return fail(401, { error: 'Authentication and an active tenant are required.' });
    }

    const decision = await assertOperationPermission({
      ...getSmrtConfig('Item'),
      action: 'create',
      collection: 'items',
      onDeny: 'return',
      permissionSet: locals.permissions,
      tenantId: locals.tenantId,
      userId: locals.user.id,
    });
    if (!decision.allowed) {
      return fail(403, { error: `Missing permission: ${CREATE_PERMISSION}` });
    }

    const form = await request.formData();
    const title = String(form.get('title') ?? '').trim();
    if (!title) {
      return fail(400, { title, error: 'Title is required.' });
    }

    try {
      const items = await getCollection<Item>('Item');
      await items.create({ title });
      return { created: title };
    } catch (error) {
      return fail(500, {
        title,
        error: error instanceof Error ? error.message : 'Failed to create item',
      });
    }
  },
};
