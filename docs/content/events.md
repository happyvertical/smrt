---
id: events
title: "@smrt/events: Event Management System"
sidebar_label: "@smrt/events"
sidebar_position: 7
---

# @smrt/events

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Hierarchical event management with participant tracking and SMRT framework support.

## Overview

The `@smrt/events` package provides a comprehensive event management system with support for hierarchical events, recurring series, and participant tracking. Built on the SMRT framework, it automatically generates REST APIs, CLI commands, and MCP tools for all event operations.

Events in this system are **infinitely nestable**, enabling complex scenarios like sports games with periods, goals, and assists, or conferences with sessions, panels, and presentations. Events can be standalone or part of a series (e.g., "2024 NBA Finals", "Summer Tour 2024"), with full support for recurring patterns.

The package integrates seamlessly with `@smrt/places` for location management and `@smrt/profiles` for participant tracking, providing a complete solution for managing events of any type.

## Features

- **Hierarchical Events**: Infinitely nestable event structures (e.g., Game → Period → Goal → Assist)
- **Event Series**: Group related events with recurring patterns (daily, weekly, monthly, yearly)
- **Event Types**: Define schemas and templates for different event categories
- **Participant Tracking**: Link profiles to events with roles, placement, and grouping
- **Place Integration**: Connect events to locations via `@smrt/places`
- **Profile Integration**: Track participants via `@smrt/profiles`
- **Status Lifecycle**: Managed transitions (scheduled → in_progress → completed)
- **Recurrence Patterns**: Complex recurring event schedules with count and date limits
- **Metadata Support**: Store custom JSON data on all entities
- **External System Sync**: Track external IDs and source systems
- **Utility Functions**: Date formatting, conflict detection, duration calculation
- **Auto-Generated APIs**: REST endpoints, CLI commands, and MCP tools via SMRT framework
- **Type-Safe**: Full TypeScript support with comprehensive type definitions

## Installation

```bash
# Install with pnpm (recommended)
pnpm add @smrt/events

# Or with npm
npm install @smrt/events

# Or with yarn
yarn add @smrt/events
```

## Quick Start

### Creating an Event

```typescript
import { Event, EventCollection } from '@smrt/events';

// Create an event collection
const events = await EventCollection.create();

// Create a standalone event
const meeting = await events.create({
  name: 'Town Council Meeting',
  slug: 'town-council-2024-01-15',
  description: 'Monthly town council meeting',
  startDate: new Date('2024-01-15T19:00:00'),
  endDate: new Date('2024-01-15T21:00:00'),
  status: 'scheduled',
  placeId: 'town-hall-id', // From @smrt/places
});

console.log(`Created event: ${meeting.name}`);
```

### Creating an Event Series

```typescript
import { EventSeries, EventSeriesCollection } from '@smrt/events';

// Create a series for recurring meetings
const series = await EventSeriesCollection.create();

const townCouncilSeries = await series.create({
  name: 'Town Council 2024',
  slug: 'town-council-2024',
  description: 'Monthly town council meetings for 2024',
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-12-31'),
  recurrence: {
    frequency: 'monthly',
    interval: 1, // Every month
    byMonthDay: [15], // On the 15th
  },
});

// Create events within the series
const januaryMeeting = await events.create({
  name: 'Town Council Meeting - January',
  slug: 'town-council-2024-01',
  seriesId: townCouncilSeries.id,
  startDate: new Date('2024-01-15T19:00:00'),
  endDate: new Date('2024-01-15T21:00:00'),
  round: 1, // First meeting of the year
});
```

### Creating Hierarchical Events

```typescript
// Create a sports game
const game = await events.create({
  name: 'Lakers vs Warriors',
  slug: 'lakers-warriors-2024-01-20',
  typeId: 'basketball-game',
  startDate: new Date('2024-01-20T19:30:00'),
  endDate: new Date('2024-01-20T22:00:00'),
  status: 'in_progress',
});

// Create periods within the game
const firstQuarter = await events.create({
  name: '1st Quarter',
  slug: 'lakers-warriors-2024-01-20-q1',
  parentEventId: game.id, // Nested under game
  startDate: new Date('2024-01-20T19:30:00'),
  endDate: new Date('2024-01-20T19:42:00'),
});

// Create a goal within the quarter
const goal = await events.create({
  name: 'Three-pointer',
  slug: 'lakers-warriors-2024-01-20-q1-goal-1',
  parentEventId: firstQuarter.id, // Nested under quarter
  startDate: new Date('2024-01-20T19:35:23'),
});

// Navigate the hierarchy
const hierarchy = await goal.getHierarchy();
console.log('Ancestors:', hierarchy.ancestors); // [game, firstQuarter]
console.log('Current:', hierarchy.current); // goal
console.log('Descendants:', hierarchy.descendants); // []
```

### Managing Participants

```typescript
import { EventParticipant, EventParticipantCollection } from '@smrt/events';

const participants = await EventParticipantCollection.create();

// Add a speaker to a conference
const speaker = await participants.create({
  eventId: conferenceId,
  profileId: 'john-doe-id', // From @smrt/profiles
  role: 'speaker',
  placement: 0, // First speaker
});

// Add competitors to a sports game
const homeTeam = await participants.create({
  eventId: game.id,
  profileId: 'lakers-id',
  role: 'home',
  placement: 0,
  metadata: { score: 98 },
});

const awayTeam = await participants.create({
  eventId: game.id,
  profileId: 'warriors-id',
  role: 'away',
  placement: 1,
  metadata: { score: 102 },
});

// Get all participants for an event
const gameParticipants = await game.getParticipants();
console.log(`${gameParticipants.length} participants`);
```

### Working with Event Types

```typescript
import { EventType, EventTypeCollection } from '@smrt/events';

const eventTypes = await EventTypeCollection.create();

// Define a schema for basketball games
const basketballType = await eventTypes.create({
  name: 'Basketball Game',
  slug: 'basketball-game',
  description: 'Professional basketball game',
  schema: {
    quarters: { type: 'number', default: 4 },
    overtimes: { type: 'number', default: 0 },
  },
  participantSchema: {
    team: { type: 'string', required: true },
    score: { type: 'number', default: 0 },
  },
});

// Use the type when creating events
const game = await events.create({
  name: 'Championship Game',
  typeId: basketballType.id,
  // ... other properties
});
```

### Searching and Filtering Events

```typescript
// Get upcoming events
const upcomingEvents = await events.list({
  where: {
    status: 'scheduled',
    startDate: { gt: new Date() },
  },
  orderBy: { startDate: 'asc' },
  limit: 10,
});

// Get events at a specific place
const venueEvents = await events.list({
  where: { placeId: 'madison-square-garden' },
});

// Get all events in a series
const seriesEvents = await events.list({
  where: { seriesId: townCouncilSeries.id },
});

// Get in-progress events
const liveEvents = await events.list({
  where: { status: 'in_progress' },
});
```

### Using Utility Functions

```typescript
import {
  formatEventDateRange,
  generateEventSlug,
  checkSchedulingConflict,
  calculateDuration,
  formatDuration,
  isEventNow,
  getEventStatusFromDates,
  sortEventsByDate,
  validateEventStatus,
  calculateNextOccurrence,
} from '@smrt/events';

// Format date ranges
const dateStr = formatEventDateRange(
  new Date('2024-01-15T19:00:00'),
  new Date('2024-01-15T21:00:00')
);
console.log(dateStr); // "1/15/2024 7:00:00 PM - 9:00:00 PM"

// Generate slugs
const slug = generateEventSlug('Lakers vs Warriors', new Date('2024-01-20'));
console.log(slug); // "lakers-vs-warriors-2024-01-20"

// Check for conflicts
const hasConflict = checkSchedulingConflict(
  new Date('2024-01-15T19:00:00'),
  new Date('2024-01-15T21:00:00'),
  new Date('2024-01-15T20:00:00'),
  new Date('2024-01-15T22:00:00')
);
console.log(hasConflict); // true

// Calculate and format duration
const durationMs = calculateDuration(
  new Date('2024-01-15T19:00:00'),
  new Date('2024-01-15T21:30:00')
);
console.log(formatDuration(durationMs)); // "2h 30m"

// Check if event is happening now
const isLive = isEventNow(
  new Date('2024-01-15T19:00:00'),
  new Date('2024-01-15T21:00:00')
);

// Validate status transitions
const canTransition = validateEventStatus('scheduled', 'in_progress');
console.log(canTransition); // true

const invalidTransition = validateEventStatus('completed', 'scheduled');
console.log(invalidTransition); // false

// Calculate next occurrence for recurring events
const nextOccurrence = calculateNextOccurrence(
  {
    frequency: 'weekly',
    interval: 1,
    byDay: ['MO', 'WE', 'FR'],
  },
  new Date('2024-01-15')
);

// Sort events by date
const sortedEvents = sortEventsByDate(allEvents, true); // ascending
```

### Advanced: Working with Recurrence

```typescript
// Create a weekly recurring series
const weeklyMeeting = await series.create({
  name: 'Weekly Team Standup',
  recurrence: {
    frequency: 'weekly',
    interval: 1,
    byDay: ['MO', 'WE', 'FR'], // Monday, Wednesday, Friday
    until: new Date('2024-12-31'),
  },
});

// Create a monthly recurring series
const monthlyMeeting = await series.create({
  name: 'Monthly Board Meeting',
  recurrence: {
    frequency: 'monthly',
    interval: 1,
    byMonthDay: [1], // First of the month
    count: 12, // 12 occurrences total
  },
});

// Create yearly recurring event
const annualEvent = await series.create({
  name: 'Annual Conference',
  recurrence: {
    frequency: 'yearly',
    interval: 1,
    byMonth: [6], // June
    byMonthDay: [15], // 15th
  },
});

// Parse and work with recurrence patterns
const pattern = weeklyMeeting.getRecurrence();
if (pattern) {
  console.log(`Repeats ${pattern.frequency}, every ${pattern.interval || 1}`);
}
```

### Advanced: Event Status Management

```typescript
// Update event status with validation
async function updateEventStatus(event: Event, newStatus: EventStatus) {
  if (validateEventStatus(event.status, newStatus)) {
    await event.updateStatus(newStatus);
    console.log(`Status updated to ${newStatus}`);
  } else {
    console.error(`Invalid transition: ${event.status} → ${newStatus}`);
  }
}

// Auto-update status based on dates
const suggestedStatus = getEventStatusFromDates(
  event.startDate!,
  event.endDate,
  event.status
);

if (suggestedStatus !== event.status) {
  await event.updateStatus(suggestedStatus);
}

// Check if event is in progress
if (event.isInProgress()) {
  console.log('Event is currently happening!');
}
```

### Advanced: Metadata Management

```typescript
// Store custom data on events
event.setMetadata({
  ticketsSold: 1250,
  revenue: 45000,
  weather: 'sunny',
});

// Update specific metadata fields
event.updateMetadata({ ticketsSold: 1300 });

// Retrieve metadata
const metadata = event.getMetadata();
console.log(`Tickets sold: ${metadata.ticketsSold}`);

// Store participant-specific metadata
participant.setMetadata({
  goals: 3,
  assists: 2,
  minutesPlayed: 42,
});
```

## API Reference

For complete API documentation, see the generated TypeDoc documentation or visit the [SMRT Framework documentation site](https://happyvertical.github.io/smrt/api/events/globals).

### Core Classes

- **Event**: Hierarchical event instances with infinite nesting
- **EventSeries**: Groups of related events with recurrence patterns
- **EventType**: Event schemas and templates
- **EventParticipant**: Links participants to events with roles
- **EventCollection**: CRUD operations for events
- **EventSeriesCollection**: CRUD operations for event series
- **EventTypeCollection**: CRUD operations for event types
- **EventParticipantCollection**: CRUD operations for participants

### Type Definitions

- **EventStatus**: `'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'postponed'`
- **ParticipantRole**: Common roles like `'speaker'`, `'home'`, `'away'`, `'organizer'`, etc.
- **RecurrenceFrequency**: `'daily' | 'weekly' | 'monthly' | 'yearly'`
- **RecurrencePattern**: Complex recurrence definitions with count, until, and day-of-week filters

### Utility Functions

- **formatEventDateRange()**: Format date ranges as human-readable strings
- **generateEventSlug()**: Create URL-friendly slugs
- **checkSchedulingConflict()**: Detect overlapping events
- **calculateDuration()**: Calculate time between dates
- **formatDuration()**: Human-readable duration strings
- **isEventNow()**: Check if event is currently happening
- **getEventStatusFromDates()**: Auto-detect status from dates
- **sortEventsByDate()**: Sort events chronologically
- **validateEventStatus()**: Validate status transitions
- **calculateNextOccurrence()**: Calculate next recurring event date
- **parseRecurrencePattern()**: Parse recurrence from string or object

## License

This package is part of the SMRT Framework and is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.
