/**
 * Type definitions for @have/events
 */

import type { SmrtObjectOptions } from '@smrt/core';

/**
 * Event status lifecycle
 */
export type EventStatus =
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'postponed';

/**
 * Common participant roles
 */
export type ParticipantRole =
  // Sports
  | 'home'
  | 'away'
  | 'competitor'
  // Entertainment
  | 'headliner'
  | 'opener'
  | 'performer'
  // Professional
  | 'speaker'
  | 'panelist'
  | 'moderator'
  | 'presenter'
  // General
  | 'organizer'
  | 'attendee'
  | 'volunteer'
  | 'host';

/**
 * Recurrence frequency
 */
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

/**
 * Recurrence pattern for repeating events
 */
export interface RecurrencePattern {
  frequency: RecurrenceFrequency;
  interval?: number; // Repeat every N days/weeks/months/years
  count?: number; // Number of occurrences
  until?: Date; // End date for recurrence
  byDay?: string[]; // Days of week (e.g., ['MO', 'WE', 'FR'])
  byMonthDay?: number[]; // Days of month (e.g., [1, 15])
  byMonth?: number[]; // Months (1-12)
  bySetPos?: number[]; // Specific occurrence (e.g., [2] for second Tuesday)
}

/**
 * Options for creating EventType
 */
export interface EventTypeOptions extends SmrtObjectOptions {
  id?: string;
  slug?: string;
  name?: string;
  description?: string;
  schema?: Record<string, any> | string; // JSON schema or JSON string
  participantSchema?: Record<string, any> | string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for creating EventSeries
 */
export interface EventSeriesOptions extends SmrtObjectOptions {
  id?: string;
  typeId?: string;
  organizerId?: string; // FK to Profile from @have/profiles
  name?: string;
  slug?: string;
  description?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  recurrence?: RecurrencePattern | string; // Pattern or JSON string
  metadata?: Record<string, any> | string;
  externalId?: string;
  source?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for creating Event
 */
export interface EventOptions extends SmrtObjectOptions {
  id?: string;
  seriesId?: string; // Nullable - standalone events don't have series
  parentEventId?: string; // Nullable - for hierarchical events
  typeId?: string;
  placeId?: string; // FK to Place from @have/places
  name?: string;
  slug?: string;
  description?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  status?: EventStatus;
  round?: number | null; // Sequence/round number in series
  metadata?: Record<string, any> | string;
  externalId?: string;
  source?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for creating EventParticipant
 */
export interface EventParticipantOptions extends SmrtObjectOptions {
  id?: string;
  eventId?: string;
  profileId?: string; // FK to Profile from @have/profiles
  role?: ParticipantRole | string; // Allow custom roles
  placement?: number | null; // Numeric position/placement
  groupId?: string; // Optional grouping (e.g., team ID for individual players)
  metadata?: Record<string, any> | string;
  externalId?: string;
  source?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Search filters for events
 */
export interface EventSearchFilters {
  typeId?: string;
  seriesId?: string;
  placeId?: string;
  status?: EventStatus | EventStatus[];
  startDate?: Date;
  endDate?: Date;
  organizerId?: string;
}

/**
 * Search filters for event series
 */
export interface EventSeriesSearchFilters {
  typeId?: string;
  organizerId?: string;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Search filters for participants
 */
export interface ParticipantSearchFilters {
  eventId?: string;
  profileId?: string;
  role?: ParticipantRole | string;
  groupId?: string;
}
