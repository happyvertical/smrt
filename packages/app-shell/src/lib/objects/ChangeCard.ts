import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

export type ChangeCardSource = 'assistant' | 'import' | 'api' | 'quick';
export type ChangeCardStatus = 'active' | 'removed';

/**
 * One owner-meaningful change in a `ChangeBatch`: it may hold several engine
 * commands ("add a Fulfillment field" is one card). Removing a card is a soft
 * delete (`removed`) so it can be put back. `opaque` cards stand for a draft
 * that was already open before changes waiting existed: they hold no commands
 * and cannot be removed or edited. JSON columns are text. Written only by
 * `changes.ts`; no generated surface.
 */
@smrt({
  tableName: 'change_cards',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['id'],
  tenantScoped: { mode: 'optional' },
})
export class ChangeCard extends SmrtObject {
  @field({ type: 'text', required: true, requiredFor: 'identity' })
  batchId: string = '';

  /** Order in the batch, from 0, never reused. */
  @field({ type: 'integer' })
  position: number = 0;

  /** Cards of one table (an import's load) share a group key; empty for none. */
  @field({ type: 'text' })
  cardGroup: string = '';

  @field({ type: 'text' })
  source: ChangeCardSource = 'api';

  /** The engine commands, JSON array text. */
  @field({ type: 'text' })
  commands: string = '[]';

  @field({ type: 'text' })
  summary: string = '';

  @field({ type: 'text' })
  status: ChangeCardStatus = 'active';

  /** Bumped by every edit; part of the batch digest. */
  @field({ type: 'integer' })
  revision: number = 1;

  /** True for a draft adopted as it was: no commands, not removable. */
  @field({ type: 'boolean' })
  opaque: boolean = false;

  /** The last check's findings for this card, JSON array text. */
  @field({ type: 'text' })
  checks: string = '[]';

  /**
   * The working copy's version numbers this card's commands made, JSON array
   * text: how an exact-check blocker that names a version finds its card.
   */
  @field({ type: 'text' })
  draftVersions: string = '[]';

  /** Review questions for this card, JSON array text. */
  @field({ type: 'text' })
  questions: string = '[]';

  /**
   * The owner's comments on this card and the assistant's answers, JSON array
   * text. Comments shipped inside `questions` (kind `comment`) in v0.62.14;
   * `changes.ts` still reads those and moves them here on the next write.
   */
  @field({ type: 'text' })
  comments: string = '[]';

  @field({ type: 'text' })
  threadId: string = '';

  @field({ type: 'text' })
  messageId: string = '';

  @field({ type: 'text' })
  createdBy: string = '';

  @field({ type: 'text' })
  createdAt: string = '';
}

export class ChangeCardCollection extends SmrtCollection<ChangeCard> {
  static readonly _itemClass = ChangeCard;
}
