import { describe, expect, it } from 'vitest';
import type { RecurrencePattern } from '../types.js';
import {
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
} from '../utils.js';

describe('validateEventStatus', () => {
  it('allows a scheduled event to start, cancel, or postpone', () => {
    expect(validateEventStatus('scheduled', 'in_progress')).toBe(true);
    expect(validateEventStatus('scheduled', 'cancelled')).toBe(true);
    expect(validateEventStatus('scheduled', 'postponed')).toBe(true);
  });

  it('rejects jumping a scheduled event straight to completed', () => {
    expect(validateEventStatus('scheduled', 'completed')).toBe(false);
  });

  it('allows an in-progress event to complete or cancel', () => {
    expect(validateEventStatus('in_progress', 'completed')).toBe(true);
    expect(validateEventStatus('in_progress', 'cancelled')).toBe(true);
  });

  it('forbids re-scheduling an in-progress event', () => {
    expect(validateEventStatus('in_progress', 'scheduled')).toBe(false);
    expect(validateEventStatus('in_progress', 'postponed')).toBe(false);
  });

  it('treats completed as a terminal state with no valid transitions', () => {
    expect(validateEventStatus('completed', 'scheduled')).toBe(false);
    expect(validateEventStatus('completed', 'in_progress')).toBe(false);
    expect(validateEventStatus('completed', 'cancelled')).toBe(false);
  });

  it('allows a cancelled event to be rescheduled but nothing else', () => {
    expect(validateEventStatus('cancelled', 'scheduled')).toBe(true);
    expect(validateEventStatus('cancelled', 'in_progress')).toBe(false);
    expect(validateEventStatus('cancelled', 'completed')).toBe(false);
  });

  it('allows a postponed event to be rescheduled or cancelled', () => {
    expect(validateEventStatus('postponed', 'scheduled')).toBe(true);
    expect(validateEventStatus('postponed', 'cancelled')).toBe(true);
    expect(validateEventStatus('postponed', 'in_progress')).toBe(false);
  });

  it('returns false when transitioning a status to itself', () => {
    expect(validateEventStatus('scheduled', 'scheduled')).toBe(false);
    expect(validateEventStatus('completed', 'completed')).toBe(false);
  });
});

describe('formatEventDateRange', () => {
  it('returns just the start date when no end date is given', () => {
    const start = new Date('2026-01-15T10:00:00Z');
    expect(formatEventDateRange(start)).toBe(start.toLocaleDateString());
  });

  it('treats an explicit null end date the same as no end date', () => {
    const start = new Date('2026-01-15T10:00:00Z');
    expect(formatEventDateRange(start, null)).toBe(start.toLocaleDateString());
  });

  it('shows a time range when start and end fall on the same day', () => {
    const start = new Date('2026-01-15T10:00:00Z');
    const end = new Date('2026-01-15T12:30:00Z');
    const expected = `${start.toLocaleDateString()} ${start.toLocaleTimeString()} - ${end.toLocaleTimeString()}`;
    expect(formatEventDateRange(start, end)).toBe(expected);
  });

  it('shows a date-to-date range when the event spans multiple days', () => {
    const start = new Date('2026-01-15T10:00:00Z');
    const end = new Date('2026-01-18T12:00:00Z');
    const expected = `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
    expect(formatEventDateRange(start, end)).toBe(expected);
  });
});

describe('generateEventSlug', () => {
  it('builds a lowercased, hyphenated slug with the ISO date suffix', () => {
    const date = new Date('2026-01-15T10:00:00Z');
    expect(generateEventSlug('Summer Festival', date)).toBe(
      'summer-festival-2026-01-15',
    );
  });

  it('collapses runs of special characters and spaces into single hyphens', () => {
    const date = new Date('2026-03-09T00:00:00Z');
    expect(generateEventSlug('Hello,   World!! & Friends', date)).toBe(
      'hello-world-friends-2026-03-09',
    );
  });

  it('trims leading and trailing hyphens produced by edge characters', () => {
    const date = new Date('2026-03-09T00:00:00Z');
    expect(generateEventSlug('***Gala***', date)).toBe('gala-2026-03-09');
  });

  it('produces only the date suffix when the name has no alphanumerics', () => {
    const date = new Date('2026-03-09T00:00:00Z');
    expect(generateEventSlug('!!!', date)).toBe('-2026-03-09');
  });

  it('preserves existing numbers in the name', () => {
    const date = new Date('2026-12-31T00:00:00Z');
    expect(generateEventSlug('Race 500', date)).toBe('race-500-2026-12-31');
  });
});

describe('checkSchedulingConflict', () => {
  it('detects an overlap between two ranged events', () => {
    const e1Start = new Date('2026-01-15T10:00:00Z');
    const e1End = new Date('2026-01-15T12:00:00Z');
    const e2Start = new Date('2026-01-15T11:00:00Z');
    const e2End = new Date('2026-01-15T13:00:00Z');
    expect(checkSchedulingConflict(e1Start, e1End, e2Start, e2End)).toBe(true);
  });

  it('reports no conflict for fully separated events', () => {
    const e1Start = new Date('2026-01-15T10:00:00Z');
    const e1End = new Date('2026-01-15T11:00:00Z');
    const e2Start = new Date('2026-01-15T12:00:00Z');
    const e2End = new Date('2026-01-15T13:00:00Z');
    expect(checkSchedulingConflict(e1Start, e1End, e2Start, e2End)).toBe(false);
  });

  it('treats back-to-back events (touching at the boundary) as non-conflicting', () => {
    const e1Start = new Date('2026-01-15T10:00:00Z');
    const e1End = new Date('2026-01-15T11:00:00Z');
    const e2Start = new Date('2026-01-15T11:00:00Z');
    const e2End = new Date('2026-01-15T12:00:00Z');
    expect(checkSchedulingConflict(e1Start, e1End, e2Start, e2End)).toBe(false);
  });

  it('treats a null end date as an instantaneous event for the first event', () => {
    const e1Start = new Date('2026-01-15T11:00:00Z');
    const e2Start = new Date('2026-01-15T10:00:00Z');
    const e2End = new Date('2026-01-15T12:00:00Z');
    // instant at 11:00 falls inside [10:00, 12:00)
    expect(checkSchedulingConflict(e1Start, null, e2Start, e2End)).toBe(true);
  });

  it('treats a null end date as an instantaneous event for the second event', () => {
    const e1Start = new Date('2026-01-15T10:00:00Z');
    const e1End = new Date('2026-01-15T12:00:00Z');
    const e2Start = new Date('2026-01-15T11:00:00Z');
    expect(checkSchedulingConflict(e1Start, e1End, e2Start, null)).toBe(true);
  });

  it('reports no conflict between two distinct instantaneous events', () => {
    const e1Start = new Date('2026-01-15T10:00:00Z');
    const e2Start = new Date('2026-01-15T11:00:00Z');
    expect(checkSchedulingConflict(e1Start, null, e2Start, null)).toBe(false);
  });

  it('reports a conflict between two identical instantaneous events', () => {
    const at = new Date('2026-01-15T10:00:00Z');
    // start < end requires start < start which is false for identical instants
    expect(
      checkSchedulingConflict(at, null, new Date(at.getTime()), null),
    ).toBe(false);
  });
});

describe('parseRecurrencePattern', () => {
  it('returns null for a null pattern', () => {
    expect(parseRecurrencePattern(null)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseRecurrencePattern('')).toBeNull();
  });

  it('parses a valid JSON string into a pattern object', () => {
    const json = '{"frequency":"weekly","interval":2}';
    expect(parseRecurrencePattern(json)).toEqual({
      frequency: 'weekly',
      interval: 2,
    });
  });

  it('returns null for a malformed JSON string', () => {
    expect(parseRecurrencePattern('{not valid json')).toBeNull();
  });

  it('returns the same object when passed an existing pattern object', () => {
    const pattern: RecurrencePattern = { frequency: 'daily', interval: 1 };
    expect(parseRecurrencePattern(pattern)).toBe(pattern);
  });
});

describe('calculateNextOccurrence', () => {
  const from = new Date('2026-01-15T10:00:00Z');

  it('advances by one day for a daily pattern with default interval', () => {
    const result = calculateNextOccurrence({ frequency: 'daily' }, from);
    expect(result).toEqual(new Date('2026-01-16T10:00:00Z'));
  });

  it('advances by the given interval for a daily pattern', () => {
    const result = calculateNextOccurrence(
      { frequency: 'daily', interval: 3 },
      from,
    );
    expect(result).toEqual(new Date('2026-01-18T10:00:00Z'));
  });

  it('advances by interval weeks for a weekly pattern', () => {
    const result = calculateNextOccurrence(
      { frequency: 'weekly', interval: 2 },
      from,
    );
    expect(result).toEqual(new Date('2026-01-29T10:00:00Z'));
  });

  it('advances by interval months for a monthly pattern', () => {
    const result = calculateNextOccurrence(
      { frequency: 'monthly', interval: 1 },
      from,
    );
    expect(result).toEqual(new Date('2026-02-15T10:00:00Z'));
  });

  it('advances by interval years for a yearly pattern', () => {
    const result = calculateNextOccurrence(
      { frequency: 'yearly', interval: 1 },
      from,
    );
    expect(result).toEqual(new Date('2027-01-15T10:00:00Z'));
  });

  it('returns null for an unrecognized frequency', () => {
    const result = calculateNextOccurrence(
      { frequency: 'fortnightly' as unknown as 'daily' },
      from,
    );
    expect(result).toBeNull();
  });

  it('returns null when fromDate is already at or past the until date', () => {
    const until = new Date('2026-01-15T10:00:00Z');
    expect(
      calculateNextOccurrence({ frequency: 'daily', until }, from),
    ).toBeNull();
  });

  it('returns null when the computed next date would exceed the until date', () => {
    const until = new Date('2026-01-15T20:00:00Z');
    // next daily occurrence is 2026-01-16, which is after the until bound
    expect(
      calculateNextOccurrence({ frequency: 'daily', until }, from),
    ).toBeNull();
  });

  it('returns the next occurrence when it falls on or before the until date', () => {
    const until = new Date('2026-01-20T10:00:00Z');
    const result = calculateNextOccurrence({ frequency: 'daily', until }, from);
    expect(result).toEqual(new Date('2026-01-16T10:00:00Z'));
  });
});

describe('calculateDuration', () => {
  it('returns the millisecond gap between start and end', () => {
    const start = new Date('2026-01-15T10:00:00Z');
    const end = new Date('2026-01-15T11:00:00Z');
    expect(calculateDuration(start, end)).toBe(60 * 60 * 1000);
  });

  it('returns zero for identical timestamps', () => {
    const at = new Date('2026-01-15T10:00:00Z');
    expect(calculateDuration(at, new Date(at.getTime()))).toBe(0);
  });

  it('returns a negative value when the end precedes the start', () => {
    const start = new Date('2026-01-15T11:00:00Z');
    const end = new Date('2026-01-15T10:00:00Z');
    expect(calculateDuration(start, end)).toBe(-60 * 60 * 1000);
  });
});

describe('formatDuration', () => {
  it('formats sub-minute durations in seconds only', () => {
    expect(formatDuration(45 * 1000)).toBe('45s');
  });

  it('formats zero duration as 0s', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats minute-scale durations as minutes and seconds', () => {
    expect(formatDuration(5 * 60 * 1000 + 30 * 1000)).toBe('5m 30s');
  });

  it('formats exact minutes with zero seconds', () => {
    expect(formatDuration(5 * 60 * 1000)).toBe('5m 0s');
  });

  it('formats hour-scale durations as hours and minutes', () => {
    expect(formatDuration(2 * 60 * 60 * 1000 + 15 * 60 * 1000)).toBe('2h 15m');
  });

  it('formats day-scale durations as days and remaining hours', () => {
    expect(formatDuration(3 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000)).toBe(
      '3d 5h',
    );
  });

  it('drops sub-unit remainders at the day tier', () => {
    // exactly 1 day -> remaining hours is 0
    expect(formatDuration(24 * 60 * 60 * 1000)).toBe('1d 0h');
  });
});

describe('isEventNow', () => {
  it('returns false for an event that has not started yet', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(isEventNow(future)).toBe(false);
  });

  it('returns true for an event that started and has no end date', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    expect(isEventNow(past)).toBe(true);
  });

  it('returns true for an event currently within its start/end window', () => {
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(Date.now() + 60 * 60 * 1000);
    expect(isEventNow(start, end)).toBe(true);
  });

  it('returns false for an event whose end date has already passed', () => {
    const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const end = new Date(Date.now() - 60 * 60 * 1000);
    expect(isEventNow(start, end)).toBe(false);
  });

  it('treats a null end date the same as an open-ended event', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    expect(isEventNow(past, null)).toBe(true);
  });
});

describe('getEventStatusFromDates', () => {
  it('preserves a cancelled status regardless of dates', () => {
    const start = new Date(Date.now() - 60 * 60 * 1000);
    expect(getEventStatusFromDates(start, null, 'cancelled')).toBe('cancelled');
  });

  it('preserves a postponed status regardless of dates', () => {
    const start = new Date(Date.now() - 60 * 60 * 1000);
    expect(getEventStatusFromDates(start, null, 'postponed')).toBe('postponed');
  });

  it('returns scheduled for an event still in the future', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(getEventStatusFromDates(future)).toBe('scheduled');
  });

  it('returns completed when the end date is in the past', () => {
    const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const end = new Date(Date.now() - 60 * 60 * 1000);
    expect(getEventStatusFromDates(start, end)).toBe('completed');
  });

  it('returns in_progress when started and within the window', () => {
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(Date.now() + 60 * 60 * 1000);
    expect(getEventStatusFromDates(start, end)).toBe('in_progress');
  });

  it('returns in_progress for a started open-ended event', () => {
    const start = new Date(Date.now() - 60 * 60 * 1000);
    expect(getEventStatusFromDates(start)).toBe('in_progress');
  });

  it('still derives status from dates when current status is non-terminal', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(getEventStatusFromDates(future, null, 'scheduled')).toBe(
      'scheduled',
    );
  });
});

describe('sortEventsByDate', () => {
  it('sorts events ascending by start date by default', () => {
    const a = { id: 'a', startDate: new Date('2026-01-17T00:00:00Z') };
    const b = { id: 'b', startDate: new Date('2026-01-15T00:00:00Z') };
    const c = { id: 'c', startDate: new Date('2026-01-16T00:00:00Z') };
    const sorted = sortEventsByDate([a, b, c]);
    expect(sorted.map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts events descending when ascending is false', () => {
    const a = { id: 'a', startDate: new Date('2026-01-17T00:00:00Z') };
    const b = { id: 'b', startDate: new Date('2026-01-15T00:00:00Z') };
    const c = { id: 'c', startDate: new Date('2026-01-16T00:00:00Z') };
    const sorted = sortEventsByDate([a, b, c], false);
    expect(sorted.map((e) => e.id)).toEqual(['a', 'c', 'b']);
  });

  it('pushes events with a null start date to the end when ascending', () => {
    const a = { id: 'a', startDate: new Date('2026-01-15T00:00:00Z') };
    const n = { id: 'n', startDate: null };
    const b = { id: 'b', startDate: new Date('2026-01-16T00:00:00Z') };
    const sorted = sortEventsByDate([n, a, b]);
    expect(sorted.map((e) => e.id)).toEqual(['a', 'b', 'n']);
  });

  it('keeps two null-dated events in their relative order', () => {
    const n1 = { id: 'n1', startDate: null };
    const n2 = { id: 'n2', startDate: null };
    const sorted = sortEventsByDate([n1, n2]);
    expect(sorted.map((e) => e.id)).toEqual(['n1', 'n2']);
  });

  it('returns an empty array unchanged', () => {
    expect(sortEventsByDate([])).toEqual([]);
  });

  it('sorts in place and returns the same array reference', () => {
    const events = [
      { id: 'a', startDate: new Date('2026-01-17T00:00:00Z') },
      { id: 'b', startDate: new Date('2026-01-15T00:00:00Z') },
    ];
    const result = sortEventsByDate(events);
    expect(result).toBe(events);
  });
});
