/**
 * Professional Service evidence (time entries and their commercial
 * snapshots) is owned by `@happyvertical/smrt-timesheets` (#3288; it was
 * canonical here per #1955). The same classes are re-exported under their
 * existing names so `@happyvertical/smrt-projects` imports keep working, and
 * they still map to the existing `service_time_entries`,
 * `service_charge_snapshots`, and `service_compensation_snapshots` tables, so
 * stored rows load with no schema change.
 *
 * These are re-exports, not subclasses: classes on one table must form a
 * single inheritance chain, and smrt-support's subtype (which adds `caseId` /
 * `specialistId`) is the one link a chain of same-named classes can carry.
 * See `packages/timesheets/AGENTS.md`.
 */
export {
  ServiceChargeSnapshot,
  ServiceChargeSnapshotCollection,
  ServiceCompensationSnapshot,
  ServiceCompensationSnapshotCollection,
  ServiceTimeEntry,
  ServiceTimeEntryCollection,
} from '@happyvertical/smrt-timesheets';
