/**
 * Shared types, enums, and lifecycle maps for `@happyvertical/smrt-support`.
 *
 * Domain language follows the HappyVertical support glossary: a **Support
 * Case** is the canonical record of a client support request; **Support
 * Interactions** are channel transports attached to it; **Service Targets**
 * are operational clocks (not contractual SLAs); a **Managed Support Plan**
 * carries the client-facing terms while a **Support Compensation Plan**
 * carries the provider-facing terms — the two are never merged.
 */

/** Support Case lifecycle states (FR-29b). */
export type SupportCaseStatus =
  | 'new'
  | 'triaged'
  | 'assigned'
  | 'in_progress'
  | 'waiting_on_client'
  | 'escalated'
  | 'resolved'
  | 'closed';

/**
 * Legal Support Case status transitions, enforced at save time by
 * {@link SupportCase} (S5 guarded-lifecycle idiom — raw mass-assignment on a
 * generated route cannot skip states). Reopening (`resolved`/`closed` back to
 * an active state) is legal here; the reopen bookkeeping (count, history
 * event) is layered by `SupportCaseService.reopen()`.
 */
export const SUPPORT_CASE_STATUS_TRANSITIONS: Record<
  SupportCaseStatus,
  SupportCaseStatus[]
> = {
  new: [
    'triaged',
    'assigned',
    'in_progress',
    'waiting_on_client',
    'escalated',
    'resolved',
    'closed',
  ],
  triaged: [
    'assigned',
    'in_progress',
    'waiting_on_client',
    'escalated',
    'resolved',
    'closed',
  ],
  assigned: [
    'triaged',
    'in_progress',
    'waiting_on_client',
    'escalated',
    'resolved',
    'closed',
  ],
  in_progress: [
    'assigned',
    'waiting_on_client',
    'escalated',
    'resolved',
    'closed',
  ],
  waiting_on_client: [
    'assigned',
    'in_progress',
    'escalated',
    'resolved',
    'closed',
  ],
  escalated: [
    'assigned',
    'in_progress',
    'waiting_on_client',
    'resolved',
    'closed',
  ],
  resolved: ['closed', 'in_progress', 'triaged'],
  closed: ['triaged', 'in_progress'],
};

/** Case statuses considered "open" for create-or-join intake dedup. */
export const OPEN_SUPPORT_CASE_STATUSES: SupportCaseStatus[] = [
  'new',
  'triaged',
  'assigned',
  'in_progress',
  'waiting_on_client',
  'escalated',
];

/** Client-facing priority (ordering/urgency inside a queue). */
export type SupportCasePriority = 'low' | 'normal' | 'high' | 'urgent';

/** Transport kind a Support Interaction arrived through. */
export type SupportChannelKind =
  | 'chat'
  | 'email'
  | 'phone'
  | 'voice'
  | 'web'
  | 'api';

/** Direction of a Support Interaction relative to the Client. */
export type SupportInteractionDirection = 'inbound' | 'outbound' | 'internal';

/** Who performed an interaction or case event. */
export type SupportActorKind = 'client' | 'specialist' | 'agent' | 'system';

/** Append-only case audit event types. */
export type SupportCaseEventType =
  | 'created'
  | 'interaction'
  | 'transition'
  | 'assignment'
  | 'ai_run'
  | 'handoff'
  | 'human_requested'
  | 'escalation'
  | 'target_scheduled'
  | 'target_satisfied'
  | 'target_breached'
  | 'target_paused'
  | 'target_resumed'
  | 'work_linked'
  | 'reopened'
  | 'plan_applied'
  | 'time_recorded'
  | 'note';

/** What kind of transport container a channel binding points at. */
export type SupportBindingKind = 'chat_room' | 'email_account';

/** Operational Work Item link kinds carried by a {@link SupportWorkLink}. */
export type SupportWorkLinkKind = 'support_work_item' | 'development_work_item';

/** Service Target clock types (FR-30/FR-31). */
export type ServiceTargetType =
  | 'acknowledgement'
  | 'response'
  | 'update'
  | 'resolution';

/** Service Target clock states. */
export type ServiceTargetStatus =
  | 'pending'
  | 'paused'
  | 'satisfied'
  | 'breached'
  | 'cancelled';

/** Why a case was escalated. */
export type SupportEscalationReason =
  | 'target_breach'
  | 'target_risk'
  | 'manual'
  | 'ai_trigger';

/** AI support workflow phases (FR-28a). */
export type SupportAiRunPhase =
  | 'acknowledge'
  | 'classify'
  | 'answer'
  | 'troubleshoot'
  | 'resolve';

/** Terminal outcome of one AI workflow phase run. */
export type SupportAiRunOutcome =
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'handed_off';

/** What triggered a Human Handoff (FR-28b). */
export type HumanHandoffTrigger =
  | 'client_request'
  | 'low_confidence'
  | 'high_severity'
  | 'sensitive'
  | 'failed_resolution'
  | 'target_risk'
  | 'policy'
  | 'manual';

/** Service Time Entry lifecycle (FR-36). */
export type ServiceTimeEntryStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'corrected';

/**
 * Legal Service Time Entry status transitions. `approved → corrected` is the
 * only exit from `approved` and is reachable exclusively through the explicit
 * correction path (the approved snapshot itself stays frozen).
 */
export const SERVICE_TIME_ENTRY_STATUS_TRANSITIONS: Record<
  ServiceTimeEntryStatus,
  ServiceTimeEntryStatus[]
> = {
  draft: ['submitted', 'rejected'],
  submitted: ['approved', 'rejected', 'draft'],
  approved: ['corrected'],
  rejected: ['draft', 'submitted'],
  corrected: [],
};

/** How a Service Time Entry was produced (FR-40). */
export type ServiceTimeEntrySource = 'timer' | 'manual' | 'import' | 'agent';

/** Who/what delivered the work behind a Service Time Entry. */
export type SupportParticipantKind = 'human' | 'agent';

/** Which approval path accepted a Service Time Entry (FR-36). */
export type TimeEntryApprovalPath =
  | 'automatic'
  | 'operator'
  | 'client'
  | 'threshold';

/** Derived commercial snapshot lifecycle (charges and compensation). */
export type SupportSettlementStatus =
  | 'pending'
  | 'final'
  | 'corrected'
  | 'voided';

/** Support Specialist availability window kinds. */
export type SupportAvailabilityKind = 'weekly' | 'on_call' | 'time_off';

/** Support Specialist activation state. */
export type SupportSpecialistStatus = 'active' | 'inactive';

/** Project Support Qualification levels. */
export type SupportQualificationLevel = 'trainee' | 'qualified' | 'expert';

/** A weekly coverage window in a plan's coverage calendar. */
export interface CoverageWindow {
  /** 0 = Sunday … 6 = Saturday (JS `Date#getDay` convention). */
  weekday: number;
  /** Minutes from midnight, inclusive start. */
  startMinute: number;
  /** Minutes from midnight, exclusive end. */
  endMinute: number;
}

/** Per-severity Service Target minutes; `null` disables that clock. */
export interface ServiceTargetMinutes {
  acknowledgementMinutes: number | null;
  responseMinutes: number | null;
  updateMinutes: number | null;
  resolutionMinutes: number | null;
}

/** One step of a plan's escalation policy, applied in `level` order. */
export interface EscalationStep {
  level: number;
  action: 'notify' | 'reassign';
  /** Profile ids to notify (recorded on the escalation; delivery is app-side). */
  notifyProfileIds?: string[];
  /** Minutes after the previous step before this one fires (0 = immediately). */
  delayMinutes?: number;
}

/** A severity definition entry in a plan (key → labels). */
export interface SeverityDefinition {
  label: string;
  description?: string;
}

/**
 * Default severity vocabulary used when a plan doesn't define its own.
 * `sev1` is the most severe.
 */
export const DEFAULT_SEVERITY_DEFINITIONS: Record<string, SeverityDefinition> =
  {
    sev1: { label: 'Critical', description: 'Service down or unusable' },
    sev2: { label: 'Major', description: 'Significant degradation' },
    sev3: { label: 'Minor', description: 'Limited impact' },
    sev4: { label: 'Question', description: 'Question or request' },
  };

/** Time-entry approval policy carried by a Managed Support Plan (FR-36). */
export interface TimeApprovalPolicy {
  /** Base path when no threshold applies. */
  mode: 'automatic' | 'operator' | 'client';
  /** Entries longer than this require review even under `automatic`. */
  thresholdMinutes?: number;
  /** Entries pricing above this amount require review even under `automatic`. */
  thresholdAmount?: number;
}

/** One piece of work evidence attached to a Service Time Entry. */
export interface TimeEntryEvidence {
  kind: string;
  ref: string;
  label?: string;
}

/**
 * Parse a JSON value stored as text, returning the fallback on malformed
 * input (never throws — stored JSON may predate schema changes). Accepts an
 * already-parsed value (e.g. a `type: 'json'` column that hydrated as an
 * object) and hands it back unchanged.
 */
export function parseJsonField<T>(raw: unknown, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  // Text columns hydrate as strings; a non-string here means the caller
  // already holds a parsed value — hand it back rather than throwing.
  if (typeof raw !== 'string') {
    return raw as T;
  }
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** Parse a JSON array-of-strings field, tolerating malformed input. */
export function parseStringArrayField(
  raw: string | null | undefined,
): string[] {
  const parsed = parseJsonField<unknown>(raw, []);
  return Array.isArray(parsed)
    ? parsed.filter((value): value is string => typeof value === 'string')
    : [];
}
