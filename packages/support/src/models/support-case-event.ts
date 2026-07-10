/**
 * SupportCaseEvent — append-only audit trail for a Support Case: creations,
 * transitions, assignments, AI runs, handoffs, escalations, target state
 * changes, work links, and reopens. Together with interactions this is the
 * "complete Case context" a Human Handoff transfers (FR-28b) and the reopen
 * history FR-29b preserves.
 *
 * Events are immutable: the generated surface is `list`/`get` only and the
 * service never updates an event after writing it.
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
  type SupportCaseEventType,
} from '../types.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_case_events',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class SupportCaseEvent extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('SupportCase', { required: true })
  caseId: string = '';

  @field({ type: 'text' })
  eventType: SupportCaseEventType = 'note';

  @field({ type: 'text' })
  actorKind: SupportActorKind = 'system';

  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  actorProfileId: string | null = null;

  occurredAt: Date = new Date();

  /** One-line human-readable summary for the case timeline. */
  @field({ type: 'text' })
  summary: string = '';

  /** Structured event payload (transition from/to, rationale, evidence, …). */
  @field({ type: 'text' })
  payload: string = '{}';

  getPayload(): Record<string, unknown> {
    return parseJsonField(this.payload, {});
  }

  setPayload(value: Record<string, unknown>): void {
    this.payload = JSON.stringify(value ?? {});
  }
}

export class SupportCaseEventCollection extends SmrtCollection<SupportCaseEvent> {
  static readonly _itemClass = SupportCaseEvent;

  /** All events for a case, oldest first. */
  async forCase(
    caseId: string,
    options: { eventType?: SupportCaseEventType } = {},
  ): Promise<SupportCaseEvent[]> {
    const where: Record<string, unknown> = { caseId };
    if (options.eventType !== undefined) {
      where.eventType = options.eventType;
    }
    return this.list({ where, orderBy: 'occurred_at ASC' });
  }
}

export default SupportCaseEvent;
