/**
 * Utility functions for @have/events package
 */

import type { EventStatus, RecurrencePattern } from './types';

/**
 * Validate event status transition
 *
 * @param currentStatus - Current event status
 * @param newStatus - Proposed new status
 * @returns True if transition is valid
 */
export function validateEventStatus(
  currentStatus: EventStatus,
  newStatus: EventStatus,
): boolean {
  // Define valid transitions
  const validTransitions: Record<EventStatus, EventStatus[]> = {
    scheduled: ['in_progress', 'cancelled', 'postponed'],
    in_progress: ['completed', 'cancelled'],
    completed: [], // Cannot transition from completed
    cancelled: ['scheduled'], // Can reschedule
    postponed: ['scheduled', 'cancelled'],
  };

  return validTransitions[currentStatus]?.includes(newStatus) || false;
}

/**
 * Format event date range as string
 *
 * @param startDate - Event start date
 * @param endDate - Event end date (optional)
 * @returns Formatted date range string
 */
export function formatEventDateRange(
  startDate: Date,
  endDate?: Date | null,
): string {
  const start = startDate.toLocaleDateString();

  if (!endDate) {
    return start;
  }

  // Same day
  if (startDate.toDateString() === endDate.toDateString()) {
    return `${start} ${startDate.toLocaleTimeString()} - ${endDate.toLocaleTimeString()}`;
  }

  // Multi-day
  return `${start} - ${endDate.toLocaleDateString()}`;
}

/**
 * Generate unique slug for an event
 *
 * @param name - Event name
 * @param date - Event date
 * @returns URL-friendly slug
 */
export function generateEventSlug(name: string, date: Date): string {
  const namePart = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const datePart = date.toISOString().split('T')[0]; // YYYY-MM-DD

  return `${namePart}-${datePart}`;
}

/**
 * Check if events have scheduling conflict
 *
 * @param event1Start - First event start
 * @param event1End - First event end
 * @param event2Start - Second event start
 * @param event2End - Second event end
 * @returns True if events overlap
 */
export function checkSchedulingConflict(
  event1Start: Date,
  event1End: Date | null,
  event2Start: Date,
  event2End: Date | null,
): boolean {
  // If either event has no end date, assume it's instantaneous
  const e1End = event1End || event1Start;
  const e2End = event2End || event2Start;

  // Check for overlap
  return event1Start < e2End && e1End > event2Start;
}

/**
 * Parse recurrence pattern from various formats
 *
 * @param pattern - Recurrence pattern (object or string)
 * @returns Parsed RecurrencePattern or null
 */
export function parseRecurrencePattern(
  pattern: RecurrencePattern | string | null,
): RecurrencePattern | null {
  if (!pattern) return null;

  if (typeof pattern === 'string') {
    try {
      return JSON.parse(pattern) as RecurrencePattern;
    } catch {
      return null;
    }
  }

  return pattern;
}

/**
 * Calculate next occurrence for a recurring event
 *
 * @param pattern - Recurrence pattern
 * @param fromDate - Date to calculate from
 * @returns Next occurrence date or null
 */
export function calculateNextOccurrence(
  pattern: RecurrencePattern,
  fromDate: Date,
): Date | null {
  const { frequency, interval = 1, until, count } = pattern;

  // Check if recurrence has ended
  if (until && fromDate >= until) return null;

  // Calculate next date based on frequency
  const nextDate = new Date(fromDate);

  switch (frequency) {
    case 'daily':
      nextDate.setDate(nextDate.getDate() + interval);
      break;
    case 'weekly':
      nextDate.setDate(nextDate.getDate() + interval * 7);
      break;
    case 'monthly':
      nextDate.setMonth(nextDate.getMonth() + interval);
      break;
    case 'yearly':
      nextDate.setFullYear(nextDate.getFullYear() + interval);
      break;
    default:
      return null;
  }

  // Check if we've exceeded until date
  if (until && nextDate > until) return null;

  return nextDate;
}

/**
 * Calculate duration between two dates
 *
 * @param startDate - Start date
 * @param endDate - End date
 * @returns Duration in milliseconds
 */
export function calculateDuration(startDate: Date, endDate: Date): number {
  return endDate.getTime() - startDate.getTime();
}

/**
 * Format duration as human-readable string
 *
 * @param durationMs - Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Check if an event is happening now
 *
 * @param startDate - Event start date
 * @param endDate - Event end date (optional)
 * @returns True if event is currently in progress
 */
export function isEventNow(startDate: Date, endDate?: Date | null): boolean {
  const now = new Date();

  if (now < startDate) return false;
  if (endDate && now > endDate) return false;

  return true;
}

/**
 * Get event status based on dates
 *
 * @param startDate - Event start date
 * @param endDate - Event end date (optional)
 * @param currentStatus - Current status (optional)
 * @returns Suggested event status
 */
export function getEventStatusFromDates(
  startDate: Date,
  endDate?: Date | null,
  currentStatus?: EventStatus,
): EventStatus {
  // Don't override cancelled or postponed status
  if (currentStatus === 'cancelled' || currentStatus === 'postponed') {
    return currentStatus;
  }

  const now = new Date();

  if (now < startDate) {
    return 'scheduled';
  }

  if (endDate && now > endDate) {
    return 'completed';
  }

  return 'in_progress';
}

/**
 * Sort events by start date
 *
 * @param events - Array of objects with startDate property
 * @param ascending - Sort ascending (default: true)
 * @returns Sorted array
 */
export function sortEventsByDate<T extends { startDate: Date | null }>(
  events: T[],
  ascending: boolean = true,
): T[] {
  return events.sort((a, b) => {
    if (!a.startDate && !b.startDate) return 0;
    if (!a.startDate) return 1;
    if (!b.startDate) return -1;

    const diff = a.startDate.getTime() - b.startDate.getTime();
    return ascending ? diff : -diff;
  });
}
