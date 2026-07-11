/**
 * Coverage-calendar math tests (#1929): deterministic business-time
 * arithmetic — 24×7 fast path, business-hours windows, holiday skips,
 * timezone wall-clock evaluation, and the add/measure symmetry the Service
 * Target clocks rely on.
 *
 * Fixed instants throughout (2026-01-05 is a Monday).
 */

import { describe, expect, it } from 'vitest';
import type { CoverageCalendar } from './coverage-calendar.js';
import {
  addCoveredMinutes,
  coveredMinutesBetween,
  MAX_COVERAGE_SCAN_DAYS,
  zonedParts,
} from './coverage-calendar.js';

const ALWAYS: CoverageCalendar = { windows: [], holidays: [], timezone: 'UTC' };

/** Mon–Fri 09:00–17:00 UTC. */
const BUSINESS_HOURS: CoverageCalendar = {
  windows: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    startMinute: 9 * 60,
    endMinute: 17 * 60,
  })),
  holidays: [],
  timezone: 'UTC',
};

describe('zonedParts', () => {
  it('projects a UTC instant onto a timezone wall clock (0 = Sunday)', () => {
    const parts = zonedParts(
      new Date('2026-01-05T14:00:00Z'),
      'America/New_York',
    );
    expect(parts.weekday).toBe(1); // Monday
    expect(parts.minuteOfDay).toBe(9 * 60); // 09:00 EST
    expect(parts.dateKey).toBe('2026-01-05');
  });

  it('crosses the date line relative to UTC when the zone is behind', () => {
    const parts = zonedParts(
      new Date('2026-01-05T02:00:00Z'),
      'America/New_York',
    );
    expect(parts.dateKey).toBe('2026-01-04'); // still Sunday evening in NY
    expect(parts.weekday).toBe(0);
    expect(parts.minuteOfDay).toBe(21 * 60);
  });
});

describe('addCoveredMinutes', () => {
  it('is plain wall-clock arithmetic on an empty 24×7 calendar', () => {
    const from = new Date('2026-01-05T10:00:00Z');
    expect(addCoveredMinutes(ALWAYS, from, 90).toISOString()).toBe(
      '2026-01-05T11:30:00.000Z',
    );
  });

  it('carries a Friday-afternoon clock over the weekend to Monday morning', () => {
    // Friday 2026-01-09 16:30 + 60 covered minutes: 30 min remain on Friday,
    // the other 30 land after Monday 09:00.
    const from = new Date('2026-01-09T16:30:00Z');
    expect(addCoveredMinutes(BUSINESS_HOURS, from, 60).toISOString()).toBe(
      '2026-01-12T09:30:00.000Z',
    );
  });

  it('skips holidays entirely', () => {
    const withHoliday: CoverageCalendar = {
      ...BUSINESS_HOURS,
      holidays: ['2026-01-12'],
    };
    const from = new Date('2026-01-09T16:30:00Z');
    expect(addCoveredMinutes(withHoliday, from, 60).toISOString()).toBe(
      '2026-01-13T09:30:00.000Z',
    );
  });

  it('excludes holidays under 24×7 coverage too', () => {
    const alwaysButHoliday: CoverageCalendar = {
      windows: [],
      holidays: ['2026-01-12'],
      timezone: 'UTC',
    };
    // Sunday 12:00 + 24h of coverage: 12h on Sunday, Monday skipped, the
    // remaining 12h complete on Tuesday at noon.
    const from = new Date('2026-01-11T12:00:00Z');
    expect(
      addCoveredMinutes(alwaysButHoliday, from, 24 * 60).toISOString(),
    ).toBe('2026-01-13T12:00:00.000Z');
  });

  it('evaluates windows in the calendar timezone from a UTC instant', () => {
    const newYork: CoverageCalendar = {
      windows: [{ weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60 }],
      holidays: [],
      timezone: 'America/New_York',
    };
    // Monday 13:00 UTC is 08:00 EST — before coverage opens. The clock only
    // starts at 09:00 EST (14:00 UTC) and 60 covered minutes end 15:00 UTC.
    const from = new Date('2026-01-05T13:00:00Z');
    expect(addCoveredMinutes(newYork, from, 60).toISOString()).toBe(
      '2026-01-05T15:00:00.000Z',
    );
  });

  it('returns the start instant for zero or negative minutes', () => {
    const from = new Date('2026-01-05T10:00:00Z');
    expect(addCoveredMinutes(BUSINESS_HOURS, from, 0).getTime()).toBe(
      from.getTime(),
    );
  });

  it(`throws a descriptive error after ${MAX_COVERAGE_SCAN_DAYS} uncovered days`, () => {
    const empty: CoverageCalendar = {
      windows: [{ weekday: 1, startMinute: 0, endMinute: 0 }],
      holidays: [],
      timezone: 'UTC',
    };
    expect(() =>
      addCoveredMinutes(empty, new Date('2026-01-05T10:00:00Z'), 30),
    ).toThrow(/no coverage found within 400 days/);
  });
});

describe('coveredMinutesBetween', () => {
  it('measures plain elapsed minutes on an empty 24×7 calendar', () => {
    expect(
      coveredMinutesBetween(
        ALWAYS,
        new Date('2026-01-05T10:00:00Z'),
        new Date('2026-01-05T11:30:00Z'),
      ),
    ).toBe(90);
  });

  it('returns zero for inverted or empty ranges', () => {
    const at = new Date('2026-01-05T10:00:00Z');
    expect(coveredMinutesBetween(BUSINESS_HOURS, at, at)).toBe(0);
    expect(
      coveredMinutesBetween(
        BUSINESS_HOURS,
        at,
        new Date('2026-01-05T09:00:00Z'),
      ),
    ).toBe(0);
  });

  it('only counts covered time across a weekend', () => {
    // Friday 16:30 → Monday 09:30 spans 30 covered Friday minutes and 30
    // covered Monday minutes.
    expect(
      coveredMinutesBetween(
        BUSINESS_HOURS,
        new Date('2026-01-09T16:30:00Z'),
        new Date('2026-01-12T09:30:00Z'),
      ),
    ).toBe(60);
  });

  it('is symmetric with addCoveredMinutes', () => {
    const cases: Array<{
      calendar: CoverageCalendar;
      from: Date;
      minutes: number;
    }> = [
      {
        calendar: BUSINESS_HOURS,
        from: new Date('2026-01-09T16:30:00Z'),
        minutes: 60,
      },
      {
        calendar: BUSINESS_HOURS,
        from: new Date('2026-01-07T10:00:00Z'),
        minutes: 120,
      },
      {
        calendar: { ...BUSINESS_HOURS, holidays: ['2026-01-08'] },
        from: new Date('2026-01-07T16:00:00Z'),
        minutes: 180,
      },
      {
        calendar: {
          windows: [{ weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60 }],
          holidays: [],
          timezone: 'America/New_York',
        },
        from: new Date('2026-01-05T13:00:00Z'),
        minutes: 45,
      },
    ];
    for (const { calendar, from, minutes } of cases) {
      const due = addCoveredMinutes(calendar, from, minutes);
      expect(coveredMinutesBetween(calendar, from, due)).toBeCloseTo(
        minutes,
        6,
      );
    }
  });
});
