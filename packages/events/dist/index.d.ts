/**
 * @have/events
 *
 * Hierarchical event management with participant tracking and SMRT framework support
 *
 * @packageDocumentation
 */
export { EventCollection } from './collections/EventCollection';
export { EventParticipantCollection } from './collections/EventParticipantCollection';
export { EventSeriesCollection } from './collections/EventSeriesCollection';
export { EventTypeCollection } from './collections/EventTypeCollection';
export { Event } from './models/Event';
export { EventParticipant } from './models/EventParticipant';
export { EventSeries } from './models/EventSeries';
export { EventType } from './models/EventType';
export type { EventOptions, EventParticipantOptions, EventSearchFilters, EventSeriesOptions, EventSeriesSearchFilters, EventStatus, EventTypeOptions, ParticipantRole, ParticipantSearchFilters, RecurrenceFrequency, RecurrencePattern, } from './types';
export { calculateDuration, calculateNextOccurrence, checkSchedulingConflict, formatDuration, formatEventDateRange, generateEventSlug, getEventStatusFromDates, isEventNow, parseRecurrencePattern, sortEventsByDate, validateEventStatus, } from './utils';
//# sourceMappingURL=index.d.ts.map