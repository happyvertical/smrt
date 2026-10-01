/**
 * Shared time-entry vocabulary.
 *
 * `smrt-projects` and `smrt-support` re-export these names unchanged, so a
 * value typed against either package's alias is the same type.
 */

/** How a time entry was produced. */
export type ServiceTimeEntrySource = 'timer' | 'manual' | 'import' | 'agent';

/**
 * Time-entry approval lifecycle. `approved → corrected` is the only exit from
 * `approved`, reached by recording a correction as a new row.
 */
export type ServiceTimeEntryStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'corrected';

/** Who delivered the work behind a time entry. */
export type ServiceParticipantKind = 'human' | 'agent';

/**
 * Legal time-entry status transitions, enforced by `ServiceTimeEntry.save()`.
 * Approved and corrected rows additionally keep their evidence frozen.
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

/** One piece of supporting evidence attached to a time entry. */
export interface ServiceEvidence {
  kind: string;
  ref?: string;
  summary?: string;
  capturedAt?: string;
  [key: string]: unknown;
}
