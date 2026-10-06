/**
 * Server entry of a minimal app that consumes `@happyvertical/smrt-chat` and
 * mounts the one-call MCP route for its own `Note` model (#3490). The
 * integration test bundles it the way `smrt app build` does — chat and the
 * smrt-agents it brings inlined into the app's server output — and drives the
 * built handler from a plain Node process.
 */
import * as chat from '@happyvertical/smrt-chat';
import { mountMcpAppRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import {
  field,
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

@smrt({ mcp: { include: ['list', 'get'] } })
export class Note extends SmrtObject {
  @field({ type: 'text' })
  title: string = '';
}

export class NoteCollection extends SmrtCollection<Note> {
  static readonly _itemClass = Note;
}

/** Keeps the consumed package in the bundle, as a generated register does. */
export const chatExportCount = Object.keys(chat).length;

let db: Awaited<ReturnType<typeof getTestDatabase>> | undefined;

/** Creates the app's table and one row; the runtime never creates schema. */
export async function setup(): Promise<void> {
  ObjectRegistry.registerCollection('Note', NoteCollection);
  db = await getTestDatabase({ classes: ['Note'] });
  await db.insert('notes', {
    id: '00000000-0000-4000-8000-000000003490',
    slug: 'first',
    context: '',
    title: 'bundled note',
  });
}

export const POST = mountMcpAppRoute({
  models: [Note],
  requiredScopes: ['notes.read'],
  effects: ['read'],
  smrtOptions: () => ({ db }),
});
