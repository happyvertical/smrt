# @happyvertical/smrt-events

Infinite-nesting event hierarchy with series, types, participants, and role/placement management.

## Models

- **Event** (STI, extends `SmrtHierarchical`): self-referencing parent-child via `parentId` (UUID). Links to `seriesId`, `typeId`, `placeId`. Status: scheduled/in_progress/completed/cancelled/postponed. Hierarchy traversal (`getParent()`, `getChildren()`, `getAncestors()`, `getDescendants()`, `getHierarchy()`, `moveTo()`) is provided by `SmrtHierarchical`; `getRootEvent()` and `isRoot()` remain on `Event`.
- **EventAsset**: dedicated owned-asset join in `event_assets` with `relationship` and `sortOrder`.
- **EventType**: classification with JSON schema for custom fields per type.
- **Event.allDay / Event.timeZone**: whole-day flag (`endDate` is the exclusive midnight after the last day) and IANA zone (empty = inherit). Manifest fields; consumers migrate with `db:migrate`.
- **EventSeries**: recurrence patterns (daily/weekly/monthly/yearly). `expandRecurrence()` (`src/recurrence.ts`) / `EventSeries.getOccurrences()` expand them into instants, keeping the start's wall-clock time in the zone. Do all date math on calendar dates and convert through `Intl` at the end — never `Date#setDate`/`getDay` on host-local time (tests pin `TZ=UTC`, so host leaks only show in production).
- **EventParticipant**: junction with `role` (home/away/speaker/panelist/etc.), `placement` (numeric — team ordering and rankings), `groupId` (team grouping within event). `conflictColumns: ['event_id', 'profile_id', 'role']`.

## Gotchas

- **No depth limit** on event hierarchy — deep nesting can cause N+1 queries
- **Placement is numeric**: used for both team ordering (0=home, 1=away) and rankings — context-dependent
- **GroupId not enforced at DB level**: for logical grouping only (e.g., team members in a game)
- **Optional tenancy** with nullable tenantId
- **Event physical foreign keys**: `parentId`, `seriesId`, and `typeId` retain
  PostgreSQL/SQLite constraints. DuckDB/JSON omit only those explicitly scoped
  physical constraints because DuckDB cannot enforce Event's self-reference or
  generated `ON UPDATE CASCADE`; UUID fields, indexes, relationship loading,
  and application-side delete enforcement remain active on every engine.
- **Metadata stored as JSON string** with get/set/update helpers
- **Owned asset helpers**: use `Event.getAssets()` / `addAsset()` / `removeAsset()` or the matching `EventCollection` wrappers instead of generic `AssetAssociation`
