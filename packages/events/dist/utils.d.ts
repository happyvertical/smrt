import { EventStatus, RecurrencePattern } from './types';
/**
 * Validate event status transition
 *
 * @param currentStatus - Current event status
 * @param newStatus - Proposed new status
 * @returns True if transition is valid
 */
export declare function validateEventStatus(currentStatus: EventStatus, newStatus: EventStatus): boolean;
/**
 * Format event date range as string
 *
 * @param startDate - Event start date
 * @param endDate - Event end date (optional)
 * @returns Formatted date range string
 */
export declare function formatEventDateRange(startDate: Date, endDate?: Date | null): string;
/**
 * Generate unique slug for an event
 *
 * @param name - Event name
 * @param date - Event date
 * @returns URL-friendly slug
 */
export declare function generateEventSlug(name: string, date: Date): string;
/**
 * Check if events have scheduling conflict
 *
 * @param event1Start - First event start
 * @param event1End - First event end
 * @param event2Start - Second event start
 * @param event2End - Second event end
 * @returns True if events overlap
 */
export declare function checkSchedulingConflict(event1Start: Date, event1End: Date | null, event2Start: Date, event2End: Date | null): boolean;
/**
 * Parse recurrence pattern from various formats
 *
 * @param pattern - Recurrence pattern (object or string)
 * @returns Parsed RecurrencePattern or null
 */
export declare function parseRecurrencePattern(pattern: RecurrencePattern | string | null): RecurrencePattern | null;
/**
 * Calculate next occurrence for a recurring event
 *
 * @param pattern - Recurrence pattern
 * @param fromDate - Date to calculate from
 * @returns Next occurrence date or null
 */
export declare function calculateNextOccurrence(pattern: RecurrencePattern, fromDate: Date): Date | null;
/**
 * Calculate duration between two dates
 *
 * @param startDate - Start date
 * @param endDate - End date
 * @returns Duration in milliseconds
 */
export declare function calculateDuration(startDate: Date, endDate: Date): number;
/**
 * Format duration as human-readable string
 *
 * @param durationMs - Duration in milliseconds
 * @returns Formatted duration string
 */
export declare function formatDuration(durationMs: number): string;
/**
 * Check if an event is happening now
 *
 * @param startDate - Event start date
 * @param endDate - Event end date (optional)
 * @returns True if event is currently in progress
 */
export declare function isEventNow(startDate: Date, endDate?: Date | null): boolean;
/**
 * Get event status based on dates
 *
 * @param startDate - Event start date
 * @param endDate - Event end date (optional)
 * @param currentStatus - Current status (optional)
 * @returns Suggested event status
 */
export declare function getEventStatusFromDates(startDate: Date, endDate?: Date | null, currentStatus?: EventStatus): EventStatus;
/**
 * Sort events by start date
 *
 * @param events - Array of objects with startDate property
 * @param ascending - Sort ascending (default: true)
 * @returns Sorted array
 */
export declare function sortEventsByDate<T extends {
    startDate: Date | null;
}>(events: T[], ascending?: boolean): T[];
//# sourceMappingURL=utils.d.ts.map