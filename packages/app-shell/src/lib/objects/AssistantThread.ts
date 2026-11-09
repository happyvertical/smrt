import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * One assistant conversation (shell.db). Written only by the assistant's
 * thread store (`$lib/server/assistant/threads`), owner scoped; no generated
 * surface.
 */
@smrt({
  tableName: 'assistant_threads',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['id'],
})
export class AssistantThread extends SmrtObject {
  /** The owner's user id. */
  @field({ type: 'text' })
  ownerId: string = '';

  @field({ type: 'text' })
  title: string = '';

  @field({ type: 'text' })
  createdAt: string = '';

  @field({ type: 'text' })
  updatedAt: string = '';
}

export class AssistantThreadCollection extends SmrtCollection<AssistantThread> {
  static readonly _itemClass = AssistantThread;
}
