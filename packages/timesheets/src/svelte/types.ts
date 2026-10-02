/**
 * Serializable view types for the timesheets approval surface.
 *
 * Components take plain view objects (not model instances) so hosts can pass
 * data across the server/client boundary. Explicit interfaces (not inline
 * intersections) keep Svelte 5 prop type evaluation cheap.
 */

/**
 * View shape for a time entry in approval/review surfaces. The first eight
 * fields deliberately match the presentation `TimeEntry` contract
 * (`./components/utils.ts`), so hosts can reuse either surface over the same
 * view rows. Domain packages extend it — smrt-support's `SupportTimeEntryView`
 * adds `caseId`.
 */
export interface TimeEntryApprovalView {
  id: string;
  /** ISO date part (`YYYY-MM-DD`) of the work period start. */
  date: string;
  /** Worked duration in decimal hours, rounded to 2 decimals. */
  hours: number;
  description: string;
  status: string;
  /** Client charge in integer minor units — `$19.99` is `1999` (#2401). */
  amount?: number;
  /**
   * ISO 4217 code `amount` / `hourlyRate` are denominated in. Carried on the
   * view because the minor-unit exponent is a property of the currency, not a
   * constant: `¥1999` is 1999 minor units, not 19.99 (#2401).
   */
  currency?: string;
  workerName?: string;
  /** Hourly rate in minor units per hour (#2401). */
  hourlyRate?: number;
  source: string;
  participantKind: string;
}

/** Human-readable label for a snake_case status value. */
export function humanizeTimeEntryStatus(value: string): string {
  return (value ?? '').replace(/_/g, ' ');
}

/** Map a time-entry status onto `StatusBadge` default color-scheme keys. */
export function timeEntryStatusBadgeKey(status: string): string {
  switch (status) {
    case 'draft':
      return 'inactive';
    case 'submitted':
      return 'pending';
    case 'approved':
      return 'success';
    case 'rejected':
      return 'error';
    case 'corrected':
      return 'warning';
    default:
      return 'pending';
  }
}
