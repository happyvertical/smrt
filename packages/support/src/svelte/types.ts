/**
 * Serializable view types for the support Svelte surfaces.
 *
 * Components take plain view objects (not model instances) so hosts can pass
 * data across the server/client boundary; `toSupportCaseView` /
 * `toCaseTimelineItemView` adapt the models. Explicit interfaces (not inline
 * intersections) keep Svelte 5 prop type evaluation cheap.
 */

import type { SupportCase } from '../models/support-case.js';
import type { SupportCaseEvent } from '../models/support-case-event.js';
import type { SupportInteraction } from '../models/support-interaction.js';
import type { CaseTimelineItem } from '../services/support-case-service.js';

export interface SupportCaseView {
  id: string;
  caseNumber: string;
  subject: string;
  status: string;
  priority: string;
  severity: string;
  channelKind: string;
  clientProfileId: string | null;
  projectId: string | null;
  assignedSpecialistId: string | null;
  assignedSpecialistName: string | null;
  reopenCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  resolutionSummary: string;
}

export interface CaseTimelineItemView {
  kind: 'interaction' | 'event';
  occurredAt: string;
  actorKind: string;
  summary: string;
  body: string;
  direction: string | null;
  channelKind: string | null;
  eventType: string | null;
}

export interface SupportWorkLinkView {
  id: string;
  linkKind: string;
  targetLabel: string;
  externalUrl: string;
  status: string;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Adapt a SupportCase model to the queue/detail view shape. */
export function toSupportCaseView(
  supportCase: SupportCase,
  options: { assignedSpecialistName?: string | null } = {},
): SupportCaseView {
  return {
    id: supportCase.id ?? '',
    caseNumber: supportCase.caseNumber,
    subject: supportCase.subject,
    status: supportCase.status,
    priority: supportCase.priority,
    severity: supportCase.severity,
    channelKind: supportCase.channelKind,
    clientProfileId: supportCase.clientProfileId,
    projectId: supportCase.projectId,
    assignedSpecialistId: supportCase.assignedSpecialistId,
    assignedSpecialistName: options.assignedSpecialistName ?? null,
    reopenCount: supportCase.reopenCount,
    createdAt: toIso(supportCase.created_at as Date | undefined),
    updatedAt: toIso(supportCase.updated_at as Date | undefined),
    resolutionSummary: supportCase.resolutionSummary,
  };
}

/** Adapt one merged timeline item (interaction or event) to its view. */
export function toCaseTimelineItemView(
  item: CaseTimelineItem,
): CaseTimelineItemView {
  if (item.kind === 'interaction' && item.interaction) {
    const interaction = item.interaction as SupportInteraction;
    return {
      kind: 'interaction',
      occurredAt: toIso(interaction.occurredAt) ?? '',
      actorKind: interaction.actorKind,
      summary: `${interaction.direction} ${interaction.channelKind}`,
      body: interaction.body,
      direction: interaction.direction,
      channelKind: interaction.channelKind,
      eventType: null,
    };
  }
  const event = item.event as SupportCaseEvent;
  return {
    kind: 'event',
    occurredAt: toIso(event.occurredAt) ?? '',
    actorKind: event.actorKind,
    summary: event.summary,
    body: '',
    direction: null,
    channelKind: null,
    eventType: event.eventType,
  };
}

/**
 * Map a case status onto smrt-ui `StatusBadge`'s default color-scheme keys
 * (`active` | `inactive` | `pending` | `error` | `success` | `warning`); pass
 * the real status as the badge `label`.
 */
export function caseStatusBadgeKey(status: string): string {
  switch (status) {
    case 'new':
    case 'triaged':
      return 'pending';
    case 'assigned':
    case 'in_progress':
      return 'active';
    case 'waiting_on_client':
      return 'warning';
    case 'escalated':
      return 'error';
    case 'resolved':
      return 'success';
    case 'closed':
      return 'inactive';
    default:
      return 'pending';
  }
}

/** Map a case priority onto `StatusBadge` default color-scheme keys. */
export function priorityBadgeKey(priority: string): string {
  switch (priority) {
    case 'urgent':
      return 'error';
    case 'high':
      return 'warning';
    case 'low':
      return 'inactive';
    default:
      return 'active';
  }
}

/** Human-readable label for a snake_case status value. */
export function humanizeStatus(value: string): string {
  return (value ?? '').replace(/_/g, ' ');
}
