/**
 * @have/events
 *
 * Hierarchical event management with participant tracking and SMRT framework support
 *
 * @packageDocumentation
 */
export { EventType } from './models/EventType';
export { EventSeries } from './models/EventSeries';
export { Event } from './models/Event';
export { EventParticipant } from './models/EventParticipant';
export { EventTypeCollection } from './collections/EventTypeCollection';
export { EventSeriesCollection } from './collections/EventSeriesCollection';
export { EventCollection } from './collections/EventCollection';
export { EventParticipantCollection } from './collections/EventParticipantCollection';
export type { EventTypeOptions, EventSeriesOptions, EventOptions, EventParticipantOptions, EventStatus, ParticipantRole, RecurrencePattern, RecurrenceFrequency, EventSearchFilters, EventSeriesSearchFilters, ParticipantSearchFilters, } from './types';
export { validateEventStatus, formatEventDateRange, generateEventSlug, checkSchedulingConflict, parseRecurrencePattern, calculateNextOccurrence, calculateDuration, formatDuration, isEventNow, getEventStatusFromDates, sortEventsByDate, } from './utils';
//# sourceMappingURL=index.d.ts.map