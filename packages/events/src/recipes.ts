/**
 * Declared recipes for smrt-events (#3590, #3604): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Event } from './models/Event.js';
import { EventParticipant } from './models/EventParticipant.js';
import { EventSeries } from './models/EventSeries.js';
import { EventType } from './models/EventType.js';

/** Events: Schedule events, group them in series and track who takes part. */
export class CalendarRecipe extends SmrtRecipe {
  static id = 'events.calendar';
  static help = './calendar.recipe.md';
  static label = 'Events';
  static summary =
    'Schedule events, group them in series and track who takes part.';
  static synonyms = [
    'calendar',
    'schedule',
    'meetings',
    'bookings',
    'attendees',
  ];
  static section = {
    id: 'calendar',
    label: 'Calendar',
    icon: 'calendar',
    description: 'Events and what is scheduled when.',
  };
  static models = [Event, EventType, EventSeries, EventParticipant];
  static nav = [
    {
      label: 'Events',
      model: Event,
      icon: 'calendar',
      description: 'Everything on your calendar, with who and when.',
    },
    {
      label: 'Event types',
      model: EventType,
      icon: 'tag',
      description: 'The kinds of events you run, such as workshops or classes.',
    },
    {
      label: 'Event series',
      model: EventSeries,
      icon: 'repeat',
      description: 'Repeating schedules, like a class every Tuesday evening.',
    },
  ];
  static options = {
    Event: {
      fields: {
        parentId: { visibility: 'hidden' },
        round: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
        externalId: { visibility: 'hidden' },
        source: { visibility: 'hidden' },
        timeZone: { visibility: 'hidden' },
      },
    },
    EventType: {
      fields: {
        schema: { visibility: 'hidden' },
        participantSchema: { visibility: 'hidden' },
      },
    },
    EventSeries: {
      fields: {
        metadata: { visibility: 'hidden' },
        externalId: { visibility: 'hidden' },
        source: { visibility: 'hidden' },
      },
    },
    EventParticipant: {
      fields: {
        groupId: { visibility: 'hidden' },
        placement: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
        externalId: { visibility: 'hidden' },
        source: { visibility: 'hidden' },
      },
    },
  } as const;
}
