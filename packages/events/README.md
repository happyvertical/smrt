# @happyvertical/smrt-events

Infinite-nesting event hierarchy with series, participant tracking, and recurrence patterns. Events can model anything from conferences with sessions to sports games with periods and goals.

## Installation

```bash
pnpm add @happyvertical/smrt-events
```

## Usage

### Hierarchical events with participants

```typescript
import { EventCollection, EventSeriesCollection, EventParticipantCollection } from '@happyvertical/smrt-events';

const events = await EventCollection.create();

// Create a game with nested periods
const game = await events.create({
  name: 'Lakers vs Warriors',
  slug: 'lakers-warriors-2024-01-20',
  startDate: new Date('2024-01-20T19:30:00'),
  endDate: new Date('2024-01-20T22:00:00'),
  status: 'scheduled',
  placeId: 'arena-id', // plain string FK to smrt-places
});

const quarter = await events.create({
  name: '1st Quarter',
  parentId: game.id, // infinite nesting (via SmrtHierarchical)
  startDate: new Date('2024-01-20T19:30:00'),
});

// Hierarchy traversal
const hierarchy = await quarter.getHierarchy();
console.log(hierarchy.ancestors.map(e => e.name)); // ['Lakers vs Warriors']

// Add participants with roles and placement
const participants = await EventParticipantCollection.create();
await participants.create({
  eventId: game.id,
  profileId: 'lakers-id', // plain string FK to smrt-profiles
  role: 'home',
  placement: 0,
});

// Recurring series
const series = await EventSeriesCollection.create();
await series.create({
  name: 'Weekly Standup',
  slug: 'weekly-standup-2024',
  recurrence: { frequency: 'weekly', interval: 1, byDay: ['MO', 'WE', 'FR'] },
});
```

### All-day events, time zones, and recurrence expansion

`Event.allDay` marks whole-day events (`startDate` is local midnight of the
first day, `endDate` the exclusive midnight after the last day) and
`Event.timeZone` is the IANA zone the event is scheduled in (empty inherits
from the series, place, or site).

`expandRecurrence(pattern, { start, rangeStart, rangeEnd, timeZone })` turns
a `RecurrencePattern` (object or stored JSON) into occurrence start instants.
It supports `frequency` daily/weekly/monthly/yearly, `interval`, `byDay`
(weekly day lists; monthly ordinals like `2TU` or `-1FR`), `byMonthDay`
(negative counts from the month end), `byMonth`, `bySetPos`, inclusive
`until`, and `count` (counted from `start`). The start's wall-clock time is
kept in `timeZone` (default `pattern.timeZone`, then UTC), so a 19:00 meeting
stays at 19:00 across daylight-saving changes. `EventSeries.getOccurrences()`
wraps it with the series' `startDate`/`endDate`.

```typescript
import { expandRecurrence } from '@happyvertical/smrt-events';

// Council meets the second Tuesday at 19:00 Edmonton time
const october = expandRecurrence(
  { frequency: 'monthly', byDay: ['2TU'] },
  {
    start: new Date('2026-01-14T02:00:00Z'), // Jan 13 19:00 MST
    rangeStart: new Date('2026-10-01T00:00:00Z'),
    rangeEnd: new Date('2026-11-01T00:00:00Z'),
    timeZone: 'America/Edmonton',
  },
);
```

### Owned assets

```typescript
import { AssetCollection } from '@happyvertical/smrt-assets';

const assets = await AssetCollection.create();
const hero = await assets.create({
  name: 'launch-poster.jpg',
  sourceUri: 'file:///tmp/launch-poster.jpg',
  mimeType: 'image/jpeg',
});

await game.addAsset(hero, 'hero');
await events.addAsset(game.id!, hero, 'gallery', 1);

const heroAssets = await game.getAssets('hero');
const galleryAssets = await events.getAssets(game.id!, 'gallery');
```

## API

### Models

| Export | Description |
|--------|------------|
| `Event` | Hierarchical event with status lifecycle, STI enabled. Links to series, type, place via string IDs; `allDay` and IANA `timeZone` fields |
| `EventSeries` | Recurring event group with recurrence patterns (daily/weekly/monthly/yearly) |
| `EventType` | Classification with JSON schema for custom fields per type |
| `EventParticipant` | Junction linking profiles to events with role, placement, and groupId |
| `EventAsset` | Dedicated owned-asset join stored in `event_assets` with `relationship` and `sortOrder` |

### Collections

| Export | Description |
|--------|------------|
| `EventCollection` | CRUD + hierarchy traversal for events |
| `EventAssetCollection` | Direct access to `event_assets` rows plus asset helper wrappers |
| `EventSeriesCollection` | CRUD for event series |
| `EventTypeCollection` | CRUD for event types |
| `EventParticipantCollection` | CRUD for participants (conflictColumns: event_id, profile_id, role) |

### Types

| Export | Description |
|--------|------------|
| `EventOptions`, `EventSeriesOptions`, `EventTypeOptions`, `EventParticipantOptions` | Creation option types for each model |
| `EventStatus` | `'scheduled' \| 'in_progress' \| 'completed' \| 'cancelled' \| 'postponed'` |
| `ParticipantRole` | Role values (speaker, home, away, organizer, etc.) |
| `RecurrenceFrequency` | `'daily' \| 'weekly' \| 'monthly' \| 'yearly'` |
| `RecurrencePattern` | Recurrence definition with count, until, byDay, byMonth filters |
| `EventSearchFilters`, `EventSeriesSearchFilters`, `ParticipantSearchFilters` | Query filter types |

### Utilities

| Export | Description |
|--------|------------|
| `formatEventDateRange` | Format start/end dates as human-readable string |
| `generateEventSlug` | Create URL-friendly slug from name + date |
| `checkSchedulingConflict` | Detect overlapping time ranges |
| `calculateDuration` | Duration in milliseconds between two dates |
| `formatDuration` | Human-readable duration (e.g., "2h 30m") |
| `isEventNow` | Check if event is currently in progress |
| `getEventStatusFromDates` | Auto-detect status from start/end dates |
| `sortEventsByDate` | Sort events chronologically |
| `validateEventStatus` | Validate status transition is allowed |
| `calculateNextOccurrence` | Next date for a recurrence pattern (host-local arithmetic; prefer `expandRecurrence`) |
| `expandRecurrence` | Time-zone-aware occurrence instants for a pattern within a window |
| `toZonedWallTime` / `fromZonedWallTime` | Convert between an instant and wall-clock fields in an IANA zone |
| `isValidTimeZone` | Check an IANA zone name against the runtime's `Intl` data |
| `parseRecurrencePattern` | Parse recurrence from string or object |

### UI Metadata

| Export | Description |
|--------|------------|
| `EVENTS_MODULE_META` | Module metadata for UI registration |
| `EVENTS_UI_SLOTS` | UI slot definitions for the events module |

### Instance Methods (Event)

`getParent()`, `getChildren()`, `getAncestors()`, `getDescendants()`, `getRootEvent()`, `getHierarchy()` -- hierarchy traversal on any Event instance.

Owned asset helpers are available on both `Event` and `EventCollection` via
`getAssets()`, `addAsset()`, and `removeAsset()`. Common relationships include
`hero`, `gallery`, `attachment`, and `thumbnail`.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@happyvertical/smrt-core` | SmrtObject/SmrtCollection base classes |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
| `@happyvertical/smrt-places` | Place references (cross-package string FKs) |
| `@happyvertical/smrt-profiles` | Participant profile references (cross-package string FKs) |
| `@happyvertical/smrt-types` | Shared TypeScript types |
| `@happyvertical/sql` | Database operations |
| `@happyvertical/ai` | AI integration |

### iCalendar source synchronization

`parseICalendarEvents(source, ics, { floatingTimeZone?, limits? })` validates
caller-supplied RFC 5545 text through the published `@happyvertical/icalendar`
facade. `expandICalendarEvents(source, ics, options)` adds a required inclusive
`rangeStart`/`rangeEnd` window. `syncICalendarSource({ db, source, ics, tenantId?,
parse?, expansion? })` persists those records and returns `created`, `updated`,
`unchanged`, and `retainedOnOmission: true`. Recurring feeds require `expansion`.
Parsing/expansion require no database or network; sync supports SQLite and
PostgreSQL with migrated Event/EventSeries schemas. Other dialects are not
currently supported ([EventSeries FK gap #3469](https://github.com/happyvertical/smrt/issues/3469)); runtime-schema adapters are rejected before mutation.

A tenant, source and UID identify a series. Its expanded occurrences use the
original RECURRENCE-ID (UTC ISO instant for timed events, calendar date for
all-day events), so a moved instance retains its ID. Non-recurring records use
UID without an occurrence suffix. Recurring masters live in series/provenance;
they are not duplicate Event rows alongside their first occurrence. RDATE is
normalized using each RDATE property's own timezone and unioned with RRULE,
duplicate instants collapse, and EXDATE slots persist as
cancelled events. Detached records override their original slot, including a
move beyond the requested window. Duplicate VEVENT identities reject the feed.

Daily, weekly, monthly and yearly RRULEs use the SDK's public recurrence engine.
The supported bounded subset is daily without BY filters; weekly BYDAY without
ordinals; monthly BYDAY or BYMONTHDAY (not both), with BYSETPOS supported only for BYDAY; and yearly
BYMONTH/BYMONTHDAY. Other BY combinations reject rather than risking unbounded
search inside the recurrence engine. COUNT, UNTIL and INTERVAL apply throughout.
Expansion rejects rather than truncates when it exceeds `limit` (default 1,000;
maximum 10,000) or `maxIterations` (default 10,000; maximum 100,000, including
slots before the window). Unsupported frequency, unknown recurrence properties,
multiple RRULEs, EXRULE, DURATION, RDATE PERIOD and RECURRENCE-ID RANGE reject.
SDK parser resource limits remain in force. Expand a practical window near the
series start; very old or dense feeds may need a deliberate higher scan budget.

IANA zones use the runtime's timezone database and the framework's wall-time
conversion: DST gaps move forward and overlaps choose the first instant. UTC
values stay UTC. Floating timed values require `parse.floatingTimeZone` (or the
same option directly on parse/expand); no host zone is inferred. All-day DATEs
use that policy or UTC, with exclusive DTEND and a default next-day end. A timed
event without DTEND has zero duration. Timed recurrence keeps the exact elapsed
duration of DTSTART to DTEND; all-day recurrence keeps calendar-day duration
across DST. Date-only recurrence remains date-only.

A higher SEQUENCE **or** a newer DTSTAMP accepts an update; equal/older versions
are unchanged. Missing SEQUENCE is zero and missing DTSTAMP is the oldest
stamp. A producer changing payload without either version marker is deliberately
ignored. Each series retains the authoritative master's SDK-serialized document
and version, including when a requested window contains no occurrences. Later
windows expand that retained document when the supplied master is stale or equal,
so unseen slots cannot be created from older payloads or recurrence rules. The
master document is written in the same transaction as occurrence updates. The
expansion requirement also applies to the retained document: a stale minimal
cancellation that resolves to a recurring master requires a window. Without one,
sync rejects and rolls back all writes; retry with bounded expansion.
A cancellation is an update, and a newer scheduled record restores it.
A minimal master cancellation (UID/STATUS/version without DTSTART) cancels known
series events and stores a series tombstone that blocks older resurrection.
No feed omission deletes events: outside-window records remain; omitted detached
exceptions stay authoritative until that detached identity reappears with a
newer version. A newer master removing EXDATE restores that generated slot.

Every sync resolves its database configuration once and performs all writes on
one transaction executor, including series creation. Failures propagate and
roll back; callers may retry the same feed. An existing SQLite/PostgreSQL
transaction is joined through an adapter savepoint, preserving caller rollback.
The caller must authorize tenant/source access and serialize concurrent syncs
for the same tenant/source; this API does not implement scheduling or locking.
An active tenant context supplies an omitted tenantId and rejects a conflicting
explicit tenantId, including a request for global rows. System contexts may
explicitly import a tenant or global source.

Source fetching (including conditional requests, unavailable-feed detection and
retry scheduling) remains caller-owned. Pass only a successfully fetched feed;
partial feeds are safe under omission retention. Sync performs no drafting or
publication. Event metadata records UID, occurrence ID, version markers,
RRULE/EXDATE/RDATE and whether the record is detached.
