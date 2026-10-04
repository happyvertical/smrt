/**
 * @happyvertical/smrt-human-resources
 *
 * HR records: who works for an organization, as what, and with what standing.
 * Employment (one record per tenant and profile, with dated terms and an
 * append-only change history) and qualifications (definitions, and what each
 * person holds, with expiry). Pay, time records, logins and identity live in
 * other packages.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires.
// See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

export { addDays, addMonths, assertIsoDate, isIsoDate } from './dates.js';
export * from './employment/index.js';
export * from './qualifications/index.js';
export {
  EMPLOYMENT_STATUS_TRANSITIONS,
  type EmploymentChangeKind,
  type EmploymentCheck,
  type EmploymentEventType,
  type EmploymentStatus,
  type HeldQualificationChangeKind,
  type HeldQualificationEventType,
  type HeldQualificationStatus,
  type HrActor,
  HrError,
  type HrErrorCode,
  type HrEvent,
  type HrEventHandler,
  type HrServiceOptions,
  type IsoDate,
  type QualificationCheck,
  type QualificationKind,
  type QualificationScope,
  SUGGESTED_WORKER_TYPES,
  type WorkerType,
} from './types.js';
export {
  HUMAN_RESOURCES_MODULE_META,
  HUMAN_RESOURCES_UI_SLOTS,
} from './ui.js';
