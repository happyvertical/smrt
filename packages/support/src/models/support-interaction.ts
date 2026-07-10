/**
 * SupportInteraction — a channel-neutral transport record attached to a
 * Support Case (FR-28/FR-29): one row per message/chat/email/voice exchange,
 * preserving chronology and transport metadata. The channel row (a
 * `ChatMessage`, an `Email`, …) stays in its own package; this row links it
 * via a qualified `sourceType`/`sourceId` pair and a globally unique
 * `sourceKey` so re-ingesting the same transport record is idempotent.
 *
 * Internal model — writes go through {@link SupportCaseService}. Generated
 * surface is read-only.
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  parseJsonField,
  type SupportActorKind,
  type SupportChannelKind,
  type SupportInteractionDirection,
} from '../types.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_interactions',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: ['source_key'],
})
export class SupportInteraction extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('SupportCase', { required: true })
  caseId: string = '';

  @field({ type: 'text' })
  direction: SupportInteractionDirection = 'inbound';

  @field({ type: 'text' })
  channelKind: SupportChannelKind = 'chat';

  @field({ type: 'text' })
  actorKind: SupportActorKind = 'client';

  /** Author identity when known (client contact, specialist, bot profile). */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  authorProfileId: string | null = null;

  /** When the exchange happened on its channel (not when it was ingested). */
  occurredAt: Date = new Date();

  /** Denormalized text body for the case timeline (source stays canonical). */
  @field({ type: 'text' })
  body: string = '';

  /**
   * Qualified class of the source transport record, e.g.
   * `@happyvertical/smrt-chat:ChatMessage` or
   * `@happyvertical/smrt-messages:Email`. Null for manual notes.
   */
  @field({ type: 'text', nullable: true })
  sourceType: string | null = null;

  /** Id of the source transport record. Null for manual notes. */
  @field({ type: 'text', nullable: true })
  sourceId: string | null = null;

  /**
   * Globally unique idempotency key for intake dedup (`conflictColumns`):
   * `chat:<messageId>`, `email:<emailId>`, or `manual:<uuid>` for
   * service-authored notes.
   */
  @field({ type: 'text' })
  sourceKey: string = '';

  @field({ type: 'text' })
  metadata: string = '{}';

  getMetadata(): Record<string, unknown> {
    return parseJsonField(this.metadata, {});
  }

  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }
}

export class SupportInteractionCollection extends SmrtCollection<SupportInteraction> {
  static readonly _itemClass = SupportInteraction;

  /** All interactions for a case in channel chronology (oldest first). */
  async forCase(caseId: string): Promise<SupportInteraction[]> {
    return this.list({
      where: { caseId },
      orderBy: 'occurred_at ASC',
    });
  }

  /** Look up an interaction by its idempotency key. */
  async bySourceKey(sourceKey: string): Promise<SupportInteraction | null> {
    const matches = await this.list({ where: { sourceKey }, limit: 1 });
    return matches[0] ?? null;
  }
}

export default SupportInteraction;
