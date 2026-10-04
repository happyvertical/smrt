/**
 * Serializable view types and pure helpers for the HR components.
 *
 * Components take plain view objects (not model instances) so hosts can pass
 * data across the server/client boundary. HR holds no identity data, so every
 * name on a view comes from the host. Dates are `YYYY-MM-DD` calendar dates:
 * all arithmetic here is UTC, never local time. Explicit interfaces (not
 * inline intersections) keep Svelte 5 prop type evaluation cheap.
 */

import type { Employment } from '../employment/models.js';
import type { ProfileQualification } from '../qualifications/service.js';
import type {
  EmploymentStatus,
  HeldQualificationStatus,
  IsoDate,
  QualificationKind,
} from '../types.js';

/** Status of a held qualification on one date (mirrors the service's type). */
export type QualificationStatusOn = HeldQualificationStatus | 'not-yet-issued';

/** One row of `EmployeeList`. */
export interface EmployeeView {
  /** The `Employment` id. */
  id: string;
  /** The person's name, supplied by the host (for example from smrt-profiles). */
  displayName: string;
  employeeNumber: string;
  position: string | null;
  workerType: string;
  status: EmploymentStatus;
  /** First day of the current (or latest) term; null when the host has none. */
  startedOn: IsoDate | null;
  /**
   * The last day employed when an end has been recorded (the latest term's
   * `endedOn`); null or omitted otherwise. `EmployeeList` shows it next to the
   * status and never compares it with today.
   */
  endsOn?: IsoDate | null;
}

/** The employment fields `toEmployeeView` reads; an `Employment` satisfies it. */
export interface EmploymentLike {
  id?: string | null;
  employeeNumber: string;
  position: string | null;
  workerType: string;
  status: EmploymentStatus;
  userId?: string | null;
}

/** Existing values passed to `EmployeeForm` when editing. */
export interface EmployeeFormInitial {
  employeeNumber: string;
  workerType: string;
  position: string | null;
  /** The linked login (`smrt-users:User` id), if any. */
  userId: string | null;
}

/**
 * What `EmployeeForm` hands to `onsubmit`. Values are trimmed; a blank
 * position or login is null. The host maps them onto `EmploymentService`:
 * a new hire onto `hire` (with the profile it chose), an edit onto
 * `changePosition` / `changeWorkerType` / `linkLogin` / `unlinkLogin` for each
 * value that differs from the stored employment, each dated `effectiveOn`.
 */
export interface EmployeeFormValues {
  employeeNumber: string;
  workerType: string;
  position: string | null;
  userId: string | null;
  /** First day employed. Set for a new hire, null for an edit. */
  startedOn: IsoDate | null;
  /** The day an edit's changes take effect. Set for an edit, null for a new hire. */
  effectiveOn: IsoDate | null;
}

/** A login the host offers in `EmployeeForm`'s login field. */
export interface EmployeeLoginOption {
  /** The `smrt-users:User` id. */
  value: string;
  /** What the person sees, for example an email address. */
  label: string;
}

/** One row of `PersonQualifications`. */
export interface PersonQualificationView {
  /** The `HeldQualification` id. */
  id: string;
  name: string;
  kind: QualificationKind;
  issuingBody: string;
  certificateNumber: string;
  issuedOn: IsoDate;
  /** Last day valid, inclusive; null never expires. */
  expiresOn: IsoDate | null;
  /** Status as of the host's "today". */
  status: QualificationStatusOn;
  /** Whole days from today to `expiresOn` (negative once past); null never expires. */
  daysUntilExpiry: number | null;
}

/** The held-qualification fields the adapters read. */
export interface HeldQualificationLike {
  id?: string | null;
  issuedOn: IsoDate;
  expiresOn: IsoDate | null;
  certificateNumber: string;
}

/** The definition fields the adapters read. */
export interface QualificationLike {
  name: string;
  kind: QualificationKind;
  issuingBody: string;
}

/** A `QualificationService.listForProfile` row, structurally. */
export interface ProfileQualificationLike {
  held: HeldQualificationLike;
  qualification: QualificationLike;
  status: QualificationStatusOn;
}

/** Resolves to `Row`, and fails to compile unless `Row` is assignable to `Like`. */
type Satisfies<Like, Row extends Like> = Row;

/**
 * Compile-time proof that what the services return fits the structural
 * inputs of the adapters below: an `Employment` is an {@link EmploymentLike}
 * and a `listForProfile` row is a {@link ProfileQualificationLike}. Typecheck
 * fails here if a model and its view input drift apart.
 */
export type HrViewInputs = [
  Satisfies<EmploymentLike, Employment>,
  Satisfies<ProfileQualificationLike, ProfileQualification>,
];

/** One row of `ExpiringQualificationsList`. */
export interface ExpiringQualificationView {
  /** The `HeldQualification` id. */
  id: string;
  /** The holder's name, supplied by the host. */
  displayName: string;
  qualificationName: string;
  expiresOn: IsoDate;
  daysUntilExpiry: number;
}

/** How a qualification is shown: its status, with "expiring soon" split out. */
export type QualificationExpiryState =
  | 'valid'
  | 'expiring-soon'
  | 'expired'
  | 'suspended'
  | 'revoked'
  | 'not-yet-issued';

/** Default "expiring soon" window, in days. */
export const DEFAULT_EXPIRING_SOON_DAYS = 30;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const WORKER_TYPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** UTC midnight of a `YYYY-MM-DD` date in milliseconds, or null when it is not a real date. */
function utcDay(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.getTime();
}

/** Whether `value` is a real calendar date written `YYYY-MM-DD`. */
export function isCalendarDate(value: unknown): value is IsoDate {
  return utcDay(value) !== null;
}

/**
 * Whole calendar days from `today` to `date` (negative when `date` is past).
 * Both are `YYYY-MM-DD`; the arithmetic is UTC, so no timezone or daylight
 * saving shift can move the answer.
 *
 * @throws RangeError when either value is not a real calendar date
 */
export function daysUntil(today: IsoDate, date: IsoDate): number {
  const from = utcDay(today);
  const to = utcDay(date);
  if (from === null || to === null)
    throw new RangeError(
      `daysUntil needs YYYY-MM-DD calendar dates, got '${String(today)}' and '${String(date)}'.`,
    );
  return Math.round((to - from) / DAY_MS);
}

/** Whether a worker type is lowercase kebab-case, as the service requires. */
export function isWorkerType(value: string): boolean {
  return WORKER_TYPE.test(value);
}

/** Message key for an employment status label. */
export function employmentStatusLabelKey(
  status: EmploymentStatus,
):
  | 'human_resources.employee_list.status_active'
  | 'human_resources.employee_list.status_on_leave'
  | 'human_resources.employee_list.status_ended' {
  switch (status) {
    case 'on-leave':
      return 'human_resources.employee_list.status_on_leave';
    case 'ended':
      return 'human_resources.employee_list.status_ended';
    default:
      return 'human_resources.employee_list.status_active';
  }
}

/** Map an employment status onto `StatusBadge` default color-scheme keys. */
export function employmentStatusBadgeKey(status: EmploymentStatus): string {
  switch (status) {
    case 'on-leave':
      return 'pending';
    case 'ended':
      return 'inactive';
    default:
      return 'active';
  }
}

/**
 * How to show a qualification: its status, with a valid one whose last day is
 * within `expiringSoonDays` (inclusive, counting today) reported as
 * `expiring-soon`. A `valid` row whose last day has passed shows as expired.
 */
export function qualificationExpiryState(
  view: Pick<PersonQualificationView, 'status' | 'daysUntilExpiry'>,
  expiringSoonDays: number = DEFAULT_EXPIRING_SOON_DAYS,
): QualificationExpiryState {
  if (view.status !== 'valid') return view.status;
  if (view.daysUntilExpiry === null) return 'valid';
  if (view.daysUntilExpiry < 0) return 'expired';
  return view.daysUntilExpiry <= expiringSoonDays ? 'expiring-soon' : 'valid';
}

/** Message key for a qualification expiry state label. */
export function qualificationStateLabelKey(
  state: QualificationExpiryState,
):
  | 'human_resources.person_qualifications.state_valid'
  | 'human_resources.person_qualifications.state_expiring_soon'
  | 'human_resources.person_qualifications.state_expired'
  | 'human_resources.person_qualifications.state_suspended'
  | 'human_resources.person_qualifications.state_revoked'
  | 'human_resources.person_qualifications.state_not_yet_issued' {
  switch (state) {
    case 'expiring-soon':
      return 'human_resources.person_qualifications.state_expiring_soon';
    case 'expired':
      return 'human_resources.person_qualifications.state_expired';
    case 'suspended':
      return 'human_resources.person_qualifications.state_suspended';
    case 'revoked':
      return 'human_resources.person_qualifications.state_revoked';
    case 'not-yet-issued':
      return 'human_resources.person_qualifications.state_not_yet_issued';
    default:
      return 'human_resources.person_qualifications.state_valid';
  }
}

/** Map a qualification expiry state onto `StatusBadge` default color-scheme keys. */
export function qualificationStateBadgeKey(
  state: QualificationExpiryState,
): string {
  switch (state) {
    case 'valid':
      return 'success';
    case 'expiring-soon':
      return 'warning';
    case 'expired':
    case 'revoked':
      return 'error';
    case 'suspended':
      return 'pending';
    default:
      return 'inactive';
  }
}

/** Message key for a qualification kind label. */
export function qualificationKindLabelKey(
  kind: QualificationKind,
):
  | 'human_resources.person_qualifications.kind_ticket'
  | 'human_resources.person_qualifications.kind_certification'
  | 'human_resources.person_qualifications.kind_authorization'
  | 'human_resources.person_qualifications.kind_training'
  | 'human_resources.person_qualifications.kind_restriction' {
  switch (kind) {
    case 'ticket':
      return 'human_resources.person_qualifications.kind_ticket';
    case 'authorization':
      return 'human_resources.person_qualifications.kind_authorization';
    case 'training':
      return 'human_resources.person_qualifications.kind_training';
    case 'restriction':
      return 'human_resources.person_qualifications.kind_restriction';
    default:
      return 'human_resources.person_qualifications.kind_certification';
  }
}

/**
 * Adapt an employment to an `EmployeeList` row. The host supplies the name
 * and the start date (from `EmploymentService.terms`), and may pass the
 * latest term's `endedOn` as `endsOn` so the list shows the last day employed
 * beside an `ended` status during a notice period.
 */
export function toEmployeeView(
  employment: EmploymentLike,
  displayName: string,
  startedOn: IsoDate | null,
  endsOn: IsoDate | null = null,
): EmployeeView {
  return {
    id: String(employment.id ?? ''),
    displayName,
    employeeNumber: employment.employeeNumber,
    position: employment.position,
    workerType: employment.workerType,
    status: employment.status,
    startedOn,
    endsOn,
  };
}

/** Adapt an employment to `EmployeeForm`'s `employee` prop. */
export function toEmployeeFormInitial(
  employment: EmploymentLike,
): EmployeeFormInitial {
  return {
    employeeNumber: employment.employeeNumber,
    workerType: employment.workerType,
    position: employment.position,
    userId: employment.userId ?? null,
  };
}

/**
 * Adapt a `QualificationService.listForProfile(profileId, today)` row. Pass
 * the same `today` given to the service, so the status and the day count agree.
 */
export function toPersonQualificationView(
  row: ProfileQualificationLike,
  today: IsoDate,
): PersonQualificationView {
  return {
    id: String(row.held.id ?? ''),
    name: row.qualification.name,
    kind: row.qualification.kind,
    issuingBody: row.qualification.issuingBody,
    certificateNumber: row.held.certificateNumber,
    issuedOn: row.held.issuedOn,
    expiresOn: row.held.expiresOn,
    status: row.status,
    daysUntilExpiry:
      row.held.expiresOn === null ? null : daysUntil(today, row.held.expiresOn),
  };
}

/**
 * Adapt a `QualificationService.expiringWithin(days, today)` row. The host
 * supplies the holder's name and the qualification's name.
 *
 * @throws RangeError when the held qualification never expires
 */
export function toExpiringQualificationView(
  held: HeldQualificationLike,
  displayName: string,
  qualificationName: string,
  today: IsoDate,
): ExpiringQualificationView {
  if (held.expiresOn === null)
    throw new RangeError('A qualification that never expires is not expiring.');
  return {
    id: String(held.id ?? ''),
    displayName,
    qualificationName,
    expiresOn: held.expiresOn,
    daysUntilExpiry: daysUntil(today, held.expiresOn),
  };
}

/** A copy sorted by soonest expiry, then holder, then qualification name. */
export function sortBySoonestExpiry(
  items: readonly ExpiringQualificationView[],
): ExpiringQualificationView[] {
  return [...items].sort(
    (a, b) =>
      a.daysUntilExpiry - b.daysUntilExpiry ||
      a.expiresOn.localeCompare(b.expiresOn) ||
      a.displayName.localeCompare(b.displayName) ||
      a.qualificationName.localeCompare(b.qualificationName),
  );
}

/**
 * Message key and day count describing how far away an expiry is. `days` is
 * always zero or more, for the `{days}` placeholder.
 */
export function expiryDistance(daysUntilExpiry: number): {
  key:
    | 'human_resources.expiry.today'
    | 'human_resources.expiry.in_one_day'
    | 'human_resources.expiry.in_days'
    | 'human_resources.expiry.one_day_ago'
    | 'human_resources.expiry.days_ago';
  days: number;
} {
  const days = Math.abs(daysUntilExpiry);
  if (daysUntilExpiry === 0)
    return { key: 'human_resources.expiry.today', days };
  if (daysUntilExpiry === 1)
    return { key: 'human_resources.expiry.in_one_day', days };
  if (daysUntilExpiry > 1)
    return { key: 'human_resources.expiry.in_days', days };
  if (daysUntilExpiry === -1)
    return { key: 'human_resources.expiry.one_day_ago', days };
  return { key: 'human_resources.expiry.days_ago', days };
}

/** A field `validateEmployeeForm` can reject. */
export type EmployeeFormField =
  | 'employeeNumber'
  | 'workerType'
  | 'startedOn'
  | 'effectiveOn';

/** Result of {@link validateEmployeeForm}. */
export type EmployeeFormValidation =
  | { ok: true; values: EmployeeFormValues }
  | { ok: false; invalid: EmployeeFormField[] };

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The raw text `EmployeeForm` collects, before trimming and checks. */
export interface EmployeeFormDraft {
  employeeNumber: string;
  workerType: string;
  position: string;
  userId: string;
  startedOn: string;
  effectiveOn: string;
}

/**
 * Normalize and check an `EmployeeForm` draft against the same field rules
 * `EmploymentService` enforces: employee number required, worker type
 * lowercase kebab-case, a real calendar start date for a new hire and a real
 * calendar effective date for an edit. The values are not a service input by
 * themselves; see {@link EmployeeFormValues} for how a host maps them.
 */
export function validateEmployeeForm(
  draft: Readonly<Partial<EmployeeFormDraft>>,
  isNew: boolean,
): EmployeeFormValidation {
  const employeeNumber = textOf(draft.employeeNumber);
  const workerType = textOf(draft.workerType);
  const startedOn = textOf(draft.startedOn);
  const effectiveOn = textOf(draft.effectiveOn);
  const invalid: EmployeeFormField[] = [];
  if (!employeeNumber) invalid.push('employeeNumber');
  if (!isWorkerType(workerType)) invalid.push('workerType');
  if (isNew && !isCalendarDate(startedOn)) invalid.push('startedOn');
  if (!isNew && !isCalendarDate(effectiveOn)) invalid.push('effectiveOn');
  if (invalid.length > 0) return { ok: false, invalid };
  return {
    ok: true,
    values: {
      employeeNumber,
      workerType,
      position: textOf(draft.position) || null,
      userId: textOf(draft.userId) || null,
      startedOn: isNew ? startedOn : null,
      effectiveOn: isNew ? null : effectiveOn,
    },
  };
}
