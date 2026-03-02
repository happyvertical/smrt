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
  parentEventId: game.id, // infinite nesting
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

## API

### Models

| Export | Description |
|--------|------------|
| `Event` | Hierarchical event with status lifecycle, STI enabled. Links to series, type, place via string IDs |
| `EventSeries` | Recurring event group with recurrence patterns (daily/weekly/monthly/yearly) |
| `EventType` | Classification with JSON schema for custom fields per type |
| `EventParticipant` | Junction linking profiles to events with role, placement, and groupId |

### Collections

| Export | Description |
|--------|------------|
| `EventCollection` | CRUD + hierarchy traversal for events |
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
| `calculateNextOccurrence` | Next date for a recurrence pattern |
| `parseRecurrencePattern` | Parse recurrence from string or object |

### UI Metadata

| Export | Description |
|--------|------------|
| `EVENTS_MODULE_META` | Module metadata for UI registration |
| `EVENTS_UI_SLOTS` | UI slot definitions for the events module |

### Instance Methods (Event)

`getParent()`, `getChildren()`, `getAncestors()`, `getDescendants()`, `getRootEvent()`, `getHierarchy()` -- hierarchy traversal on any Event instance.

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
