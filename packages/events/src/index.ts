/**
 * @have/events
 *
 * Hierarchical event management with participant tracking and SMRT framework support
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

export { EventAssetCollection } from './collections/EventAssetCollection';
export { EventCollection } from './collections/EventCollection';
export { EventParticipantCollection } from './collections/EventParticipantCollection';
export { EventSeriesCollection } from './collections/EventSeriesCollection';
// Export collections
export { EventTypeCollection } from './collections/EventTypeCollection';
export { Event } from './models/Event';
export type { EventAssetOptions } from './models/EventAsset';
export { EventAsset } from './models/EventAsset';
export { EventParticipant } from './models/EventParticipant';
export { EventSeries } from './models/EventSeries';
// Export models
export { EventType } from './models/EventType';

// Export types
export type {
  EventOptions,
  EventParticipantOptions,
  EventSearchFilters,
  EventSeriesOptions,
  EventSeriesSearchFilters,
  EventStatus,
  EventTypeOptions,
  ParticipantRole,
  ParticipantSearchFilters,
  RecurrenceFrequency,
  RecurrencePattern,
} from './types';
// Export UI metadata
export { EVENTS_MODULE_META, EVENTS_UI_SLOTS } from './ui';
// Export utilities
export {
  calculateDuration,
  calculateNextOccurrence,
  checkSchedulingConflict,
  formatDuration,
  formatEventDateRange,
  generateEventSlug,
  getEventStatusFromDates,
  isEventNow,
  parseRecurrencePattern,
  sortEventsByDate,
  validateEventStatus,
} from './utils';
