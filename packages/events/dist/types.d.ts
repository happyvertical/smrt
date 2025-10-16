import { SmrtObjectOptions } from '../../../core/smrt/src';
/**
 * Event status lifecycle
 */
export type EventStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'postponed';
/**
 * Common participant roles
 */
export type ParticipantRole = 'home' | 'away' | 'competitor' | 'headliner' | 'opener' | 'performer' | 'speaker' | 'panelist' | 'moderator' | 'presenter' | 'organizer' | 'attendee' | 'volunteer' | 'host';
/**
 * Recurrence frequency
 */
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
/**
 * Recurrence pattern for repeating events
 */
export interface RecurrencePattern {
    frequency: RecurrenceFrequency;
    interval?: number;
    count?: number;
    until?: Date;
    byDay?: string[];
    byMonthDay?: number[];
    byMonth?: number[];
    bySetPos?: number[];
}
/**
 * Options for creating EventType
 */
export interface EventTypeOptions extends SmrtObjectOptions {
    id?: string;
    slug?: string;
    name?: string;
    description?: string;
    schema?: Record<string, any> | string;
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
    organizerId?: string;
    name?: string;
    slug?: string;
    description?: string;
    startDate?: Date | null;
    endDate?: Date | null;
    recurrence?: RecurrencePattern | string;
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
    seriesId?: string;
    parentEventId?: string;
    typeId?: string;
    placeId?: string;
    name?: string;
    slug?: string;
    description?: string;
    startDate?: Date | null;
    endDate?: Date | null;
    status?: EventStatus;
    round?: number | null;
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
    profileId?: string;
    role?: ParticipantRole | string;
    placement?: number | null;
    groupId?: string;
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
//# sourceMappingURL=types.d.ts.map