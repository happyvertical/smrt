# @happyvertical/smrt-events

Infinite-nesting event hierarchy with series, types, participants, and role/placement management.

## Models

- **Event** (STI): self-referencing parent-child via `parentEventId`. Links to `seriesId`, `typeId`, `placeId`. Status: scheduled/in_progress/completed/cancelled/postponed. Hierarchy traversal: `getParent()`, `getChildren()`, `getAncestors()`, `getDescendants()`, `getRootEvent()`, `getHierarchy()`.
- **EventType**: classification with JSON schema for custom fields per type.
- **EventSeries**: recurrence patterns (daily/weekly/monthly/yearly).
- **EventParticipant**: junction with `role` (home/away/speaker/panelist/etc.), `placement` (numeric — team ordering and rankings), `groupId` (team grouping within event). `conflictColumns: ['event_id', 'profile_id', 'role']`.

## Gotchas

- **No depth limit** on event hierarchy — deep nesting can cause N+1 queries
- **Placement is numeric**: used for both team ordering (0=home, 1=away) and rankings — context-dependent
- **GroupId not enforced at DB level**: for logical grouping only (e.g., team members in a game)
- **Optional tenancy** with nullable tenantId
- **Metadata stored as JSON string** with get/set/update helpers
