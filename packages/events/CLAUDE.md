# @happyvertical/smrt-events

Event management with types, series, participants, and hierarchical scheduling. Supports sports events, meetings, conferences, and custom event types.

## Architecture

```
src/
  index.ts              # Export barrel
  types.ts              # EventStatus, ParticipantRole, RecurrencePattern, Options
  models/
    Event.ts            # Core event model with scheduling and status
    EventType.ts        # Event type classification with JSON schema
    EventSeries.ts      # Recurring event series with recurrence patterns
    EventParticipant.ts # Event-participant junction with roles and placement
  collections/
    EventCollection.ts
    EventTypeCollection.ts
    EventSeriesCollection.ts
    EventParticipantCollection.ts
```

## Key Models

- `Event` — title, startDate, endDate, status, location, typeId, seriesId
- `EventType` — Classification with JSON schema for custom fields and participant schemas
- `EventSeries` — Recurring events with recurrence patterns (daily/weekly/monthly/yearly)
- `EventParticipant` — Junction table linking events to profiles with role, placement, groupId

## Key Patterns

- **Status lifecycle**: scheduled → in_progress → completed (also: cancelled, postponed)
- **Participant roles**: home/away (sports), speaker/panelist (professional), headliner/opener (entertainment)
- **Placement**: Numeric ordering for teams (0=home, 1=away) or rankings
- **Group ID**: Groups participants within events (e.g., team members)
- **Multi-tenancy**: Optional tenant scoping via `@TenantScoped`
- **Custom conflict columns**: EventParticipant uses `[event_id, profile_id, role]` instead of slug

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`
- Optional: `@happyvertical/smrt-profiles` (for participant profile lookup)
