import { assertOperationPermission } from '@happyvertical/smrt-users';
import { fail } from '@sveltejs/kit';

import type { Note } from '$lib/objects/Note';
import { runtime } from '$lib/server/smrt';
import type { Actions, PageServerLoad } from './$types';

const READ_PERMISSION = 'notes.read';
const CREATE_PERMISSION = 'notes.create';

export interface NoteRow {
  id: string;
  title: string;
  body: string;
}

export const load: PageServerLoad = async ({ depends, locals }) => {
  depends('smrt:notes');

  const authenticated = Boolean(locals.user);
  const hasTenant = Boolean(locals.tenantId);
  const canRead =
    authenticated && hasTenant && locals.permissions.includes(READ_PERMISSION);
  const canCreate =
    authenticated && hasTenant && locals.permissions.includes(CREATE_PERMISSION);

  if (!canRead) {
    return {
      notes: [] as NoteRow[],
      canCreate,
      authenticated,
      loadError: null as string | null,
      accessMessage: !authenticated
        ? 'Sign in before loading tenant data.'
        : !hasTenant
          ? 'Select a tenant through a membership-gated session switch.'
          : `Your active role does not grant ${READ_PERMISSION}.`,
    };
  }

  try {
    const notes = await runtime.getCollection<Note>('Note');
    const rows = await notes.list({
      orderBy: 'created_at DESC',
      limit: 100,
    });

    return {
      notes: rows.flatMap((note): NoteRow[] =>
        note.id
          ? [{ id: note.id, title: note.title, body: note.body }]
          : [],
      ),
      canCreate,
      authenticated,
      loadError: null as string | null,
      accessMessage: null as string | null,
    };
  } catch (error) {
    return {
      notes: [] as NoteRow[],
      canCreate,
      authenticated,
      loadError:
        error instanceof Error ? error.message : 'Failed to load notes',
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
      ...runtime.classOptions('Note'),
      action: 'create',
      collection: 'notes',
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
    const body = String(form.get('body') ?? '').trim();
    if (!title) {
      return fail(400, { title, body, error: 'A title is required.' });
    }

    try {
      const notes = await runtime.getCollection<Note>('Note');
      await notes.create({ title, body });
      return { created: title };
    } catch (error) {
      return fail(500, {
        title,
        body,
        error: error instanceof Error ? error.message : 'Failed to create note',
      });
    }
  },
};
