/**
 * Shared vocabulary, actor, event and error types for the HR package.
 *
 * @packageDocumentation
 */

import type { Employment } from './employment/models.js';
import type { HeldQualification } from './qualifications/models.js';

/**
 * Server-side, trusted scope. The application authorizes the acting person
 * before constructing a service; `profileId` is recorded as the actor on every
 * dated change.
 */
export interface HrActor {
  /** The employing tenant. */
  tenantId: string;
  /** The profile of the person performing the action. */
  profileId: string;
}

/** A calendar date written `YYYY-MM-DD`; never an instant. */
export type IsoDate = string;

/**
 * Stored employment status. `ended` means an end has been recorded, not that
 * the person is no longer employed today: the last day may still be ahead (a
 * notice period). "Employed on a date" is computed from terms; use
 * `EmploymentService.check`, `employedOn`, `asOf` or `findByUser(userId, on)`.
 */
export type EmploymentStatus = 'active' | 'on-leave' | 'ended';

/**
 * Allowed changes of the stored status; `ended → active` is a rehire. Leave
 * recorded inside the final term of an ended employment leaves the status
 * `ended`.
 */
export const EMPLOYMENT_STATUS_TRANSITIONS: Record<
  EmploymentStatus,
  readonly EmploymentStatus[]
> = {
  active: ['on-leave', 'ended'],
  'on-leave': ['active', 'ended'],
  ended: ['active'],
};

/** Worker types shipped as suggestions; any lowercase kebab-case value works. */
export const SUGGESTED_WORKER_TYPES = [
  'employee',
  'apprentice',
  'contractor',
] as const;
/** An open vocabulary: the suggestions, or an application's own value. */
export type WorkerType =
  | (typeof SUGGESTED_WORKER_TYPES)[number]
  | (string & {});

/** Kinds of dated change kept in the employment history. */
export type EmploymentChangeKind =
  | 'hired'
  | 'ended'
  | 'rehired'
  | 'position-changed'
  | 'worker-type-changed'
  | 'leave-started'
  | 'leave-ended'
  | 'login-linked'
  | 'login-unlinked';

/**
 * What a qualification is. A `restriction` (for example "youth worker") limits
 * what its holder may do instead of permitting something.
 */
export type QualificationKind =
  | 'ticket'
  | 'certification'
  | 'authorization'
  | 'training'
  | 'restriction';

/**
 * Who a held qualification belongs to: the `person` (it survives a change of
 * employment) or the `employment` (it ends with it).
 */
export type QualificationScope = 'person' | 'employment';

/** Stored held-qualification status. Expiry on a date is computed. */
export type HeldQualificationStatus =
  | 'valid'
  | 'expired'
  | 'suspended'
  | 'revoked';

/** Kinds of dated change kept in a held qualification's history. */
export type HeldQualificationChangeKind =
  | 'granted'
  | 'renewed'
  | 'suspended'
  | 'reinstated'
  | 'revoked'
  | 'expired';

/** Result of asking whether a profile is employed on a date. */
export type EmploymentCheck =
  | { ok: true; employmentId: string; onLeave: boolean }
  | { ok: false; reason: 'not-employed' | 'not-started' | 'ended' };

/** Result of asking whether a profile holds a qualification on a date. */
export type QualificationCheck =
  | { ok: true; heldQualificationId: string; expiresOn: IsoDate | null }
  | {
      ok: false;
      reason:
        | 'not-held'
        | 'not-yet-issued'
        | 'expired'
        | 'suspended'
        | 'revoked';
    };

/** Lifecycle events for an employment. */
export type EmploymentEventType =
  | 'employment.hired'
  | 'employment.ended'
  | 'employment.rehired'
  | 'employment.position-changed'
  | 'employment.worker-type-changed'
  | 'employment.leave-started'
  | 'employment.leave-ended';

/** Lifecycle events for a held qualification. */
export type HeldQualificationEventType =
  | 'held-qualification.granted'
  | 'held-qualification.renewed'
  | 'held-qualification.suspended'
  | 'held-qualification.reinstated'
  | 'held-qualification.revoked'
  | 'held-qualification.expired';

/** Payload delivered to an {@link HrEventHandler}. */
export type HrEvent =
  | {
      type: EmploymentEventType;
      employment: Employment;
      /** The calendar date the change takes effect. */
      effectiveOn: IsoDate;
      at: Date;
      byProfileId: string;
    }
  | {
      type: HeldQualificationEventType;
      heldQualification: HeldQualification;
      effectiveOn: IsoDate;
      at: Date;
      byProfileId: string;
    };

/**
 * Event hook an application provides to react to HR changes (reminders are the
 * application's business). Called after the change commits. Delivery is
 * best-effort: a throwing handler is logged and swallowed, so it never rolls
 * back a persisted change.
 */
export type HrEventHandler = (event: HrEvent) => void | Promise<void>;

/** Options shared by the HR services. */
export interface HrServiceOptions {
  /** Optional lifecycle event hook. */
  onEvent?: HrEventHandler;
}

/** Stable error codes raised by this package. */
export type HrErrorCode =
  | 'HR_INVALID'
  | 'HR_NOT_FOUND'
  | 'HR_ACTOR_INVALID'
  | 'HR_TENANT_MISMATCH'
  | 'HR_WRITE_FORBIDDEN'
  | 'HR_HISTORY_IMMUTABLE'
  | 'HR_STATUS_TRANSITION'
  | 'HR_EMPLOYEE_NUMBER_TAKEN'
  | 'HR_ALREADY_EMPLOYED'
  | 'HR_TERM_OVERLAP'
  | 'HR_QUALIFICATION_KEY_TAKEN'
  | 'HR_ALREADY_HELD'
  | 'HR_QUALIFICATION_SCOPE';

/** Base error for this package. `code` is stable and safe to branch on. */
export class HrError extends Error {
  readonly code: HrErrorCode;

  constructor(code: HrErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HrError';
    this.code = code;
  }
}
