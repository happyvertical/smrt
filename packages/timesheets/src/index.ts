/**
 * @happyvertical/smrt-timesheets
 *
 * Shared time entries: who (a smrt-profiles Profile or an agent) worked how
 * long on what (a generic work reference), approval and correction, and the
 * immutable charge / compensation snapshots taken at approval.
 *
 * `smrt-projects` re-exports all of these classes unchanged under their
 * existing names. `smrt-support` subclasses only `ServiceTimeEntry` (adding
 * `caseId` / `specialistId`) over the same table; the snapshots and
 * `ServiceEvidenceService` are used from this package as they are.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires.
// See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

export * from './attendance.js';
export * from './models/index.js';
export * from './services/index.js';
export {
  SERVICE_TIME_ENTRY_STATUS_TRANSITIONS,
  type ServiceEvidence,
  type ServiceParticipantKind,
  type ServiceTimeEntrySource,
  type ServiceTimeEntryStatus,
} from './types.js';
export { TIMESHEETS_MODULE_META, TIMESHEETS_UI_SLOTS } from './ui.js';
