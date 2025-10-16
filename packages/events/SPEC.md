# @have/events - Event Management SMRT Module

## Overview

A generalizable event management system designed to work with any type of event: sports games, concerts, conferences, meetings, theater performances, etc.

## Design Philosophy

### Hierarchical Event Model
```
EventType → EventSeries → Event
                    ↓           ↓
            EventParticipant  Place (from @have/places)
                    ↓
            Profile (from @have/profiles)
```

## Integration with Existing Packages

### @have/places
- `Event.placeId` references a Place
- Supports venues, rooms, virtual locations
- Full geographic data and hierarchical places

### @have/profiles
- `EventSeries.organizerId` references a Profile (organizer)
- `EventParticipant.profileId` references a Profile (participant)
- Unified system for people, teams, organizations

## Core Models

### 1. EventType
Categorizes events (sports game, concert, meeting, conference, etc.)

**Fields:**
- `id`: UUID (auto-generated)
- `slug`: URL-friendly identifier (e.g., 'basketball-game', 'concert', 'conference')
- `name`: Display name (e.g., 'Basketball Game', 'Concert', 'Conference')
- `description`: Optional description
- `schema`: JSON schema for event-specific metadata validation
- `participantSchema`: JSON schema for participant-specific metadata validation
- `createdAt`: Timestamp
- `updatedAt`: Timestamp

**Examples:**
- Sports: 'basketball-game', 'hockey-game', 'race'
- Entertainment: 'concert', 'theater', 'comedy-show'
- Professional: 'conference', 'seminar', 'workshop'
- Community: 'town-hall', 'meeting', 'festival'

### 2. EventSeries
A collection of related events (season, tournament, tour, annual conference, etc.)

**Fields:**
- `id`: UUID
- `typeId`: FK to EventType
- `organizerId`: FK to Profile (from @have/profiles) - the organizing entity
- `name`: Series name (e.g., '2024 NBA Finals', 'Summer Concert Series')
- `slug`: URL-friendly identifier
- `description`: Optional description
- `startDate`: When series begins
- `endDate`: When series ends
- `recurrence`: Recurrence pattern (JSON) - for repeating series
- `metadata`: Series-specific data (JSON)
- `externalId`: External system identifier (for API integrations)
- `source`: Source system (e.g., 'ticketmaster', 'espn')
- `createdAt`: Timestamp
- `updatedAt`: Timestamp

**Use Cases:**
- Sports: NBA Playoffs, World Series, Tournament
- Music: Summer Tour 2024, Festival Weekend
- Professional: Annual Conference, Quarterly Meetings
- Community: Town Council 2024, Weekly Farmers Market

### 3. Event
Individual event instance with hierarchical nesting

**Fields:**
- `id`: UUID
- `seriesId`: FK to EventSeries (nullable for standalone events)
- `parentEventId`: FK to Event (nullable, self-referencing for hierarchy)
- `typeId`: FK to EventType
- `placeId`: FK to Place (from @have/places) - where event occurs
- `name`: Event name (e.g., 'Game 7', 'Opening Night', 'Q1 Town Hall')
- `slug`: URL-friendly identifier
- `description`: Optional description
- `startDate`: When event starts (required)
- `endDate`: When event ends (nullable for TBD)
- `status`: Event status ('scheduled', 'in_progress', 'completed', 'cancelled', 'postponed')
- `round`: Round/sequence number in series (nullable)
- `metadata`: Event-specific data (JSON) - scores, results, notes
- `externalId`: External system identifier
- `source`: Source system
- `createdAt`: Timestamp
- `updatedAt`: Timestamp

**Hierarchy Methods:**
- `getParent()` - Get parent event
- `getChildren()` - Get immediate child events
- `getAncestors()` - Get full path to root event
- `getDescendants()` - Get all nested child events
- `getRootEvent()` - Get top-level event in hierarchy
- `getHierarchy()` - Get ancestors + current + descendants

**Key Design Decisions:**
- `seriesId` is nullable - supports both series events and standalone events
- `parentEventId` enables infinite nesting (like @have/places and @have/tags)
- `status` field enables lifecycle tracking
- `round` for ordering within series
- Flexible metadata for event-specific information (scores, attendance, etc.)
- **Everything is an Event**: scheduled events, live actions, sub-events all use same model

### 4. EventParticipant
Links participants (teams, players, speakers, performers) to events

**Fields:**
- `id`: UUID
- `eventId`: FK to Event (required)
- `profileId`: FK to Profile (from @have/profiles) - the participant
- `role`: Participant role ('competitor', 'home', 'away', 'performer', 'speaker', 'attendee', 'organizer')
- `placement`: Numeric placement/position (0 = home/first, 1 = away/second, etc.)
- `groupId`: Optional grouping identifier (for team sports with individual tracking)
- `metadata`: Participant-specific data (JSON) - stats, performance notes
- `externalId`: External system identifier
- `source`: Source system
- `createdAt`: Timestamp
- `updatedAt`: Timestamp

**Role Examples:**
- Sports: 'home', 'away', 'competitor'
- Entertainment: 'headliner', 'opener', 'performer'
- Professional: 'speaker', 'panelist', 'moderator'
- General: 'attendee', 'organizer', 'volunteer'

**Placement Usage:**
- Team sports: 0 = home, 1 = away
- Racing: Grid position, finish position
- Concerts: Performance order
- Conferences: Speaking order

**GroupId Usage:**
- Track individual players on a team
- Multiple performers from same group
- Panel members from same organization

## Relationships

### Event Hierarchy (Recursive)
```
EventType (categorizes at all levels)
    ↓
EventSeries (groups related event trees)
    ↓
Event (top-level, parentEventId: null)
    ├─ Event (child, parentEventId: parent.id)
    │   └─ Event (grandchild, parentEventId: child.id)
    └─ Event (child, parentEventId: parent.id)
        ↓
    EventParticipant → Profile (@have/profiles)
        ↓
    Place (@have/places)
```

**Hierarchy Examples:**

**Sports Game:**
```
Game (Event, seriesId: season.id, parentEventId: null)
  ├─ Period 1 (Event, typeId: 'period', parentEventId: game.id)
  │   ├─ Goal at 5:23 (Event, typeId: 'goal', parentEventId: period1.id)
  │   │   └─ Assist (Event, typeId: 'assist', parentEventId: goal.id)
  │   └─ Penalty at 12:45 (Event, typeId: 'penalty', parentEventId: period1.id)
  ├─ Period 2 (Event, parentEventId: game.id)
  └─ Period 3 (Event, parentEventId: game.id)
```

**Conference:**
```
Day 1 (Event, seriesId: conference.id, parentEventId: null)
  ├─ Morning Keynote (Event, parentEventId: day1.id)
  │   ├─ Opening Remarks (Event, parentEventId: keynote.id)
  │   ├─ Main Presentation (Event, parentEventId: keynote.id)
  │   └─ Q&A Session (Event, parentEventId: keynote.id)
  │       ├─ Question 1 (Event, parentEventId: qa.id)
  │       └─ Question 2 (Event, parentEventId: qa.id)
  └─ Workshop Track A (Event, parentEventId: day1.id)
```

**Town Meeting:**
```
Council Meeting (Event, seriesId: council2024.id, parentEventId: null)
  ├─ Call to Order (Event, parentEventId: meeting.id)
  ├─ Agenda Item 1: Budget (Event, parentEventId: meeting.id)
  │   ├─ Discussion (Event, parentEventId: budget.id)
  │   ├─ Motion to Approve (Event, parentEventId: budget.id)
  │   │   ├─ Amendment (Event, parentEventId: motion.id)
  │   │   └─ Vote (Event, parentEventId: motion.id)
  │   └─ Resolution (Event, parentEventId: budget.id)
  └─ Adjournment (Event, parentEventId: meeting.id)
```

### Data Flow Examples

#### Sports Game
```typescript
EventType: 'basketball-game'
EventSeries: '2024 NBA Finals'
    organizerId: Profile('NBA')
Event: 'Game 7'
    placeId: Place('TD Garden')
    EventParticipant: Profile('Boston Celtics'), role: 'home', placement: 0
    EventParticipant: Profile('Miami Heat'), role: 'away', placement: 1
```

#### Concert
```typescript
EventType: 'concert'
EventSeries: 'Summer Tour 2024'
    organizerId: Profile('Live Nation')
Event: 'Seattle Show'
    placeId: Place('Climate Pledge Arena')
    EventParticipant: Profile('Taylor Swift'), role: 'headliner', placement: 0
    EventParticipant: Profile('Gracie Abrams'), role: 'opener', placement: 1
```

#### Town Council Meeting
```typescript
EventType: 'council-meeting'
EventSeries: 'Bentley Town Council 2024'
    organizerId: Profile('Town of Bentley')
Event: 'October Regular Meeting'
    placeId: Place('Town Hall - Council Chambers')
    EventParticipant: Profile('Mayor John Smith'), role: 'organizer'
    EventParticipant: Profile('Councillor Jane Doe'), role: 'attendee'
```

## Collections & Key Methods

### EventTypeCollection
- `getOrCreate(slug, name)` - Get or create event type
- `initializeDefaults()` - Create common event types
- `getBySlug(slug)` - Find by slug

### EventSeriesCollection
- `getByOrganizer(organizerId)` - List series by organizer
- `getActive()` - Get currently active series
- `getUpcoming()` - Get upcoming series
- `search(query, filters)` - Search series

### EventCollection
- `getBySeriesId(seriesId)` - List events in series
- `getByPlace(placeId)` - List events at location
- `getByDateRange(start, end)` - List events in date range
- `getUpcoming(limit?)` - Get upcoming events
- `getByStatus(status)` - Filter by status
- `search(query, filters)` - Full-text search with filters

### EventParticipantCollection
- `getByEvent(eventId)` - List participants for event
- `getByProfile(profileId)` - List events for participant
- `getByRole(eventId, role)` - Filter participants by role
- `getByPlacement(eventId)` - Get participants ordered by placement

## Utilities

### Event Scheduling
- `calculateRecurrence(pattern, startDate, endDate)` - Generate recurring events
- `checkConflicts(placeId, startDate, endDate)` - Check for scheduling conflicts
- `getAvailableSlots(placeId, dateRange)` - Find available time slots

### Participant Management
- `validateParticipant(eventTypeId, role)` - Validate role for event type
- `getParticipantStats(profileId, eventTypeId)` - Aggregate participant statistics
- `rankParticipants(eventId, metric)` - Rank by metadata metric

### Data Import
- `importFromExternal(source, externalId)` - Import from external systems
- `syncWithExternal(source)` - Sync with external APIs

## Example Use Cases

### 1. Sports League Management
```typescript
// Create event type
const gameType = await eventTypes.getOrCreate('hockey-game', 'Hockey Game');

// Create series (season)
const season = await series.create({
  typeId: gameType.id,
  organizerId: nhlProfile.id,
  name: '2024-25 NHL Regular Season',
  startDate: new Date('2024-10-01'),
  endDate: new Date('2025-04-15'),
});

// Schedule game
const game = await events.create({
  seriesId: season.id,
  typeId: gameType.id,
  placeId: scotiabank.id,
  name: 'Edmonton vs Calgary',
  startDate: new Date('2024-10-15T19:00:00'),
});

// Add participants
await participants.create({
  eventId: game.id,
  profileId: oilersProfile.id,
  role: 'home',
  placement: 0,
});
```

### 2. Conference Management
```typescript
const confType = await eventTypes.getOrCreate('conference', 'Conference');

const techConf = await series.create({
  typeId: confType.id,
  organizerId: devConProfile.id,
  name: 'DevCon 2024',
  startDate: new Date('2024-11-01'),
  endDate: new Date('2024-11-03'),
});

// Keynote session
const keynote = await events.create({
  seriesId: techConf.id,
  typeId: confType.id,
  placeId: mainHall.id,
  name: 'Opening Keynote',
  startDate: new Date('2024-11-01T09:00:00'),
  endDate: new Date('2024-11-01T10:30:00'),
});

// Add speaker
await participants.create({
  eventId: keynote.id,
  profileId: speakerProfile.id,
  role: 'speaker',
});
```

### 3. Recurring Town Meetings
```typescript
const meetingType = await eventTypes.getOrCreate('town-meeting', 'Town Meeting');

const councilSeries = await series.create({
  typeId: meetingType.id,
  organizerId: townProfile.id,
  name: 'Town Council 2024',
  recurrence: {
    frequency: 'monthly',
    interval: 1,
    byDay: ['TU'], // Second Tuesday
    bySetPos: [2],
  },
});

// Generate recurring meetings
const meetings = await generateRecurringEvents(councilSeries);
```

## Future Enhancements

- **Event Templates**: Reusable event configurations
- **Ticketing Integration**: Link to ticket systems
- **Results/Scoring**: Standardized result schemas by event type
- **Media Attachments**: Photos, videos, documents
- **Live Updates**: Real-time event status updates
- **Analytics**: Event and participant statistics
- **Calendar Export**: iCal/ICS generation
- **Notifications**: Event reminders and updates

## Technical Requirements

### Dependencies
- `@have/smrt` - Core SMRT framework
- `@have/utils` - Shared utilities
- `@have/places` - Venue/location management
- `@have/profiles` - Participant/organizer profiles

### Optional Integration
- `@have/cache` - Event data caching
- `@have/ai` - Event description generation, conflict detection

### Database Schema
All models use SMRT auto-generated schemas with:
- UUID primary keys
- JSON metadata fields
- External reference tracking
- Automatic timestamps
- Indexed foreign keys

## Success Criteria

✅ Can model any type of event (sports, entertainment, professional, community)
✅ Integrates seamlessly with @have/places and @have/profiles
✅ Supports both one-time and recurring events
✅ Tracks participants with flexible roles and metadata
✅ Provides full SMRT framework capabilities (API, MCP, CLI)
✅ Enables complex queries (by date, location, participant, type)
✅ Supports external system integration
