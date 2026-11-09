import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

export type AssistantRole = 'user' | 'assistant' | 'tool';

/**
 * One message of an assistant thread (shell.db): the owner's text, the
 * model's reply (with the tool calls it asked for) or a tool result. Written
 * only by the assistant's thread store; no generated surface.
 */
@smrt({
  tableName: 'assistant_messages',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['id'],
})
export class AssistantMessage extends SmrtObject {
  @field({ type: 'text' })
  threadId: string = '';

  /** Order within the thread, from 1. */
  @field({ type: 'integer' })
  seq: number = 0;

  @field({ type: 'text' })
  role: AssistantRole = 'user';

  @field({ type: 'text' })
  content: string = '';

  /** Assistant messages: the tool calls the model asked for, JSON. */
  @field({ type: 'text' })
  toolCalls: string = '';

  /** Tool messages: the call this answers. */
  @field({ type: 'text' })
  toolCallId: string = '';

  /** Tool messages: `{ name, ok, summary, approvalId? }` JSON for the chips. */
  @field({ type: 'text' })
  meta: string = '';

  @field({ type: 'text' })
  createdAt: string = '';
}

export class AssistantMessageCollection extends SmrtCollection<AssistantMessage> {
  static readonly _itemClass = AssistantMessage;
}
