/**
 * Example s-m-r-t object.
 *
 * This one declaration is the app's data model: the `smrt()` Vite plugin turns
 * it into the schema, the REST routes under `/api/notes`, the WebMCP read
 * tools, and the generated CLI/MCP commands. Rename or replace it with your
 * own objects.
 */

import {
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'],
    writable: ['title', 'body'],
  },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
@TenantScoped({ mode: 'required' })
export class Note extends SmrtObject {
  /** Tenant rows are isolated automatically by the session's tenant. */
  @tenantId()
  tenantId: string = '';

  /** Note title */
  title: string = '';

  /** Note body */
  body: string = '';
}

/** Explicit collection constructor used by generated CLI/MCP/runtime tools. */
export class NoteCollection extends SmrtCollection<Note> {
  static readonly _itemClass = Note;
}

ObjectRegistry.registerCollection('Note', NoteCollection);
