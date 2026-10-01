/**
 * expandRecurrence + EventSeries.getOccurrences.
 *
 * The package pins TZ=UTC for Vitest; these cases use non-UTC IANA zones so a
 * host-zone leak would move the asserted instants.
 */

import { describe, expect, it } from 'vitest';
import {
  EventSeries,
  expandRecurrence,
  fromZonedWallTime,
  isValidTimeZone,
  toZonedWallTime,
} from '../index.js';

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe('zoned wall time helpers', () => {
  it('round-trips a wall-clock time through a zone', () => {
    const instant = fromZonedWallTime(
      {
        year: 2026,
        month: 3,
        day: 8,
        hour: 19,
        minute: 0,
        second: 0,
        millisecond: 0,
      },
      'America/Edmonton',
    );
    // 2026-03-08 is the spring-forward day; 19:00 MDT = 01:00Z next day.
    expect(instant.toISOString()).toBe('2026-03-09T01:00:00.000Z');
    expect(toZonedWallTime(instant, 'America/Edmonton')).toMatchObject({
      year: 2026,
      month: 3,
      day: 8,
      hour: 19,
    });
  });

  it('resolves a spring-forward gap time forward by the gap', () => {
    const wall = {
      year: 2026,
      month: 3,
      day: 8,
      hour: 2,
      minute: 30,
      second: 0,
      millisecond: 0,
    };
    // 02:30 does not exist in Edmonton on 2026-03-08 (02:00 MST -> 03:00 MDT):
    // it lands at 03:30 MDT, never back at 01:30 MST.
    const edmonton = fromZonedWallTime(wall, 'America/Edmonton');
    expect(edmonton.toISOString()).toBe('2026-03-08T09:30:00.000Z');
    expect(toZonedWallTime(edmonton, 'America/Edmonton')).toMatchObject({
      day: 8,
      hour: 3,
      minute: 30,
    });
    // An east-of-UTC zone: Berlin skips 02:00-03:00 on 2026-03-29.
    const berlin = fromZonedWallTime({ ...wall, day: 29 }, 'Europe/Berlin');
    expect(berlin.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(toZonedWallTime(berlin, 'Europe/Berlin')).toMatchObject({
      hour: 3,
      minute: 30,
    });
  });

  it('resolves a fall-back repeated time to its first occurrence', () => {
    const wall = {
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 30,
      second: 0,
      millisecond: 0,
    };
    // 01:30 happens twice in Edmonton on 2026-11-01; the first is MDT.
    expect(fromZonedWallTime(wall, 'America/Edmonton').toISOString()).toBe(
      '2026-11-01T07:30:00.000Z',
    );
    // Berlin repeats 02:00-03:00 on 2026-10-25; the first is CEST.
    expect(
      fromZonedWallTime(
        { ...wall, month: 10, day: 25, hour: 2 },
        'Europe/Berlin',
      ).toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z');
  });

  it('validates zone names', () => {
    expect(isValidTimeZone('America/Edmonton')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('expandRecurrence', () => {
  const window = {
    rangeStart: new Date('2026-01-01T00:00:00Z'),
    rangeEnd: new Date('2027-01-01T00:00:00Z'),
  };

  it('keeps local time across a daylight-saving change (weekly)', () => {
    const out = expandRecurrence(
      { frequency: 'weekly' },
      {
        // Thursday 2026-03-05 19:00 MST
        start: new Date('2026-03-06T02:00:00Z'),
        ...window,
        rangeEnd: new Date('2026-03-20T00:00:00Z'),
        timeZone: 'America/Edmonton',
      },
    );
    expect(iso(out)).toEqual([
      '2026-03-06T02:00:00.000Z',
      // After spring-forward: 19:00 MDT
      '2026-03-13T01:00:00.000Z',
    ]);
  });

  it('a daily 02:30 series moves forward across the spring-forward gap', () => {
    const out = expandRecurrence(
      { frequency: 'daily' },
      {
        // 2026-03-07 02:30 MST
        start: new Date('2026-03-07T09:30:00Z'),
        rangeStart: new Date('2026-03-07T00:00:00Z'),
        rangeEnd: new Date('2026-03-10T00:00:00Z'),
        timeZone: 'America/Edmonton',
      },
    );
    expect(
      out.map((d) => {
        const w = toZonedWallTime(d, 'America/Edmonton');
        return `${w.day} ${w.hour}:${w.minute}`;
      }),
    ).toEqual(['7 2:30', '8 3:30', '9 2:30']);
  });

  it('expands daily with interval and count', () => {
    const out = expandRecurrence(
      { frequency: 'daily', interval: 2, count: 3 },
      { start: new Date('2026-05-01T12:00:00Z'), ...window },
    );
    expect(iso(out)).toEqual([
      '2026-05-01T12:00:00.000Z',
      '2026-05-03T12:00:00.000Z',
      '2026-05-05T12:00:00.000Z',
    ]);
  });

  it('expands weekly byDay with an inclusive until, in local days', () => {
    // Monday 2026-06-01 20:00 in Auckland (08:00Z)
    const out = expandRecurrence(
      {
        frequency: 'weekly',
        byDay: ['MO', 'WE'],
        until: new Date('2026-06-08T08:00:00Z'),
      },
      {
        start: new Date('2026-06-01T08:00:00Z'),
        ...window,
        timeZone: 'Pacific/Auckland',
      },
    );
    expect(iso(out)).toEqual([
      '2026-06-01T08:00:00.000Z',
      '2026-06-03T08:00:00.000Z',
      '2026-06-08T08:00:00.000Z',
    ]);
  });

  it('counts occurrences before the window toward count', () => {
    const out = expandRecurrence(
      { frequency: 'daily', count: 5 },
      {
        start: new Date('2026-01-01T09:00:00Z'),
        rangeStart: new Date('2026-01-04T00:00:00Z'),
        rangeEnd: new Date('2026-02-01T00:00:00Z'),
      },
    );
    expect(iso(out)).toEqual([
      '2026-01-04T09:00:00.000Z',
      '2026-01-05T09:00:00.000Z',
    ]);
  });

  it('expands monthly ordinal weekdays (second Tuesday, last Friday)', () => {
    const second = expandRecurrence(
      { frequency: 'monthly', byDay: ['2TU'], count: 3 },
      {
        start: new Date('2026-01-14T02:00:00Z'),
        ...window,
        timeZone: 'America/Edmonton',
      },
    );
    // Local dates: Jan 13, Feb 10, Mar 10 (19:00 MST/MDT)
    expect(
      second.map((d) => toZonedWallTime(d, 'America/Edmonton').day),
    ).toEqual([13, 10, 10]);
    expect(iso(second)[0]).toBe('2026-01-14T02:00:00.000Z');

    const lastFriday = expandRecurrence(
      { frequency: 'monthly', byDay: ['-1FR'], count: 2 },
      { start: new Date('2026-01-30T18:00:00Z'), ...window },
    );
    expect(iso(lastFriday)).toEqual([
      '2026-01-30T18:00:00.000Z',
      '2026-02-27T18:00:00.000Z',
    ]);
  });

  it('expands monthly byMonthDay (including -1) and skips short months', () => {
    const lastDay = expandRecurrence(
      { frequency: 'monthly', byMonthDay: [-1], count: 3 },
      { start: new Date('2026-01-31T00:00:00Z'), ...window },
    );
    expect(iso(lastDay)).toEqual([
      '2026-01-31T00:00:00.000Z',
      '2026-02-28T00:00:00.000Z',
      '2026-03-31T00:00:00.000Z',
    ]);

    const the31st = expandRecurrence(
      { frequency: 'monthly', count: 3 },
      { start: new Date('2026-01-31T00:00:00Z'), ...window },
    );
    expect(iso(the31st)).toEqual([
      '2026-01-31T00:00:00.000Z',
      '2026-03-31T00:00:00.000Z',
      '2026-05-31T00:00:00.000Z',
    ]);
  });

  it('applies bySetPos to a monthly weekday set', () => {
    // Last weekday of the month
    const out = expandRecurrence(
      {
        frequency: 'monthly',
        byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
        bySetPos: [-1],
        count: 2,
      },
      { start: new Date('2026-01-30T10:00:00Z'), ...window },
    );
    expect(iso(out)).toEqual([
      '2026-01-30T10:00:00.000Z',
      '2026-02-27T10:00:00.000Z',
    ]);
  });

  it('expands yearly on the start date', () => {
    const out = expandRecurrence(
      { frequency: 'yearly' },
      {
        start: new Date('2024-07-01T15:00:00Z'),
        rangeStart: new Date('2025-01-01T00:00:00Z'),
        rangeEnd: new Date('2027-12-31T00:00:00Z'),
      },
    );
    expect(iso(out)).toEqual([
      '2025-07-01T15:00:00.000Z',
      '2026-07-01T15:00:00.000Z',
      '2027-07-01T15:00:00.000Z',
    ]);
  });

  it('parses stored JSON (string until) and falls back to the pattern zone', () => {
    const stored = JSON.stringify({
      frequency: 'weekly',
      until: new Date('2026-03-13T01:00:00Z'),
      timeZone: 'America/Edmonton',
    });
    const out = expandRecurrence(stored, {
      start: new Date('2026-03-06T02:00:00Z'),
      ...window,
    });
    expect(iso(out)).toEqual([
      '2026-03-06T02:00:00.000Z',
      '2026-03-13T01:00:00.000Z',
    ]);
  });

  it('respects limit and empty/invalid input', () => {
    expect(
      expandRecurrence(
        { frequency: 'daily' },
        { start: new Date('2026-01-01T00:00:00Z'), ...window, limit: 4 },
      ),
    ).toHaveLength(4);
    expect(expandRecurrence(null, { start: new Date(), ...window })).toEqual(
      [],
    );
    expect(() =>
      expandRecurrence(
        { frequency: 'weekly', byDay: ['XX'] },
        { start: new Date('2026-01-01T00:00:00Z'), ...window },
      ),
    ).toThrow(RangeError);
    expect(() =>
      expandRecurrence(
        { frequency: 'daily' },
        {
          start: new Date('2026-01-01T00:00:00Z'),
          ...window,
          timeZone: 'Nope/Nowhere',
        },
      ),
    ).toThrow(RangeError);
  });
});

describe('EventSeries.getOccurrences', () => {
  it('expands from startDate and stops at endDate', () => {
    const series = new EventSeries({
      name: 'Council',
      startDate: new Date('2026-01-14T02:00:00Z'),
      endDate: new Date('2026-03-31T00:00:00Z'),
      recurrence: { frequency: 'monthly', byDay: ['2TU'] },
    });
    const out = series.getOccurrences(
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-12-31T00:00:00Z'),
      { timeZone: 'America/Edmonton' },
    );
    expect(out).toHaveLength(3);
    expect(
      new EventSeries({ name: 'none' }).getOccurrences(new Date(), new Date()),
    ).toEqual([]);
  });
});
