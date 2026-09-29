import { describe, expect, it } from 'vitest';
import {
  addMonthsToKey,
  dateKeyInZone,
  defaultWeekStart,
  layoutMonth,
  monthWeeks,
  shiftMonth,
  toEntries,
  toneFor,
} from '../calendar-model.js';

describe('calendar model', () => {
  it('computes days in the given zone, not the host zone', () => {
    const instant = new Date('2026-09-29T03:30:00Z');
    expect(dateKeyInZone(instant, 'America/Edmonton')).toBe('2026-09-28');
    expect(dateKeyInZone(instant, 'Pacific/Auckland')).toBe('2026-09-29');
  });

  it('builds full weeks for any first weekday', () => {
    const sunday = monthWeeks({ year: 2026, month: 9 }, 0);
    expect(sunday[0][0]).toBe('2026-08-30');
    expect(sunday.at(-1)?.[6]).toBe('2026-10-03');
    const monday = monthWeeks({ year: 2026, month: 9 }, 1);
    expect(monday[0][0]).toBe('2026-08-31');
    expect(monday).toHaveLength(5);
  });

  it('shifts months and clamps days', () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({
      year: 2027,
      month: 1,
    });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({
      year: 2025,
      month: 12,
    });
    expect(addMonthsToKey('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('reads the locale week start when the runtime knows it', () => {
    const start = defaultWeekStart('en-GB');
    expect([0, 1]).toContain(start);
    expect(defaultWeekStart('not a locale!')).toBe(0);
  });

  it('normalizes all-day dates, exclusive midnights, and timed spans', () => {
    const tz = 'America/Edmonton';
    const entries = toEntries(
      [
        { id: 'a', title: 'Fair', start: '2026-09-05', end: '2026-09-07' },
        {
          id: 'b',
          title: 'Exclusive',
          allDay: true,
          start: new Date('2026-09-10T06:00:00Z'),
          end: new Date('2026-09-12T06:00:00Z'),
        },
        {
          id: 'c',
          title: 'Late meeting',
          start: new Date('2026-09-15T01:00:00Z'),
          end: new Date('2026-09-15T03:00:00Z'),
        },
        {
          id: 'd',
          title: 'Overnight',
          start: new Date('2026-09-20T04:00:00Z'),
          end: new Date('2026-09-20T16:00:00Z'),
        },
        { id: 'bad', title: 'Bad', start: 'not a date' },
      ],
      tz,
    );
    const byId = Object.fromEntries(entries.map((e) => [e.item.id, e]));
    expect(byId.a).toMatchObject({
      startKey: '2026-09-05',
      endKey: '2026-09-07',
      allDay: true,
      band: true,
    });
    expect(byId.b).toMatchObject({
      startKey: '2026-09-10',
      endKey: '2026-09-11',
    });
    // 19:00-21:00 MDT on the 14th
    expect(byId.c).toMatchObject({
      startKey: '2026-09-14',
      endKey: '2026-09-14',
      band: false,
    });
    // 22:00 on the 19th to 10:00 on the 20th spans two days
    expect(byId.d).toMatchObject({
      startKey: '2026-09-19',
      endKey: '2026-09-20',
      band: true,
    });
    expect(byId.bad).toBeUndefined();
  });

  it('lays out bands in lanes and counts overflow as "+N more"', () => {
    const entries = toEntries(
      [
        { id: 'span', title: 'Span', start: '2026-09-01', end: '2026-09-09' },
        { id: 'one', title: 'One', start: '2026-09-02' },
        {
          id: 't1',
          title: 'T1',
          start: new Date('2026-09-02T15:00:00Z'),
        },
        {
          id: 't2',
          title: 'T2',
          start: new Date('2026-09-02T16:00:00Z'),
        },
      ],
      'UTC',
    );
    const weeks = layoutMonth({ year: 2026, month: 9 }, entries, {
      weekStartsOn: 0,
      maxPerDay: 3,
    });
    const first = weeks[0];
    // Span continues into the next week; "One" takes a second lane.
    const span = first.bands.find((b) => b.entry.item.id === 'span');
    expect(span).toMatchObject({ column: 2, span: 5, lane: 0 });
    expect(span?.continuesAfter).toBe(true);
    expect(first.lanes).toBe(2);
    const sep2 = first.days.find((d) => d.key === '2026-09-02');
    // One row left for timed items; two don't fit, so show none + "+2 more".
    expect(sep2?.visible).toHaveLength(0);
    expect(sep2?.hiddenCount).toBe(2);
    expect(sep2?.all.map((e) => e.item.id)).toEqual([
      'span',
      'one',
      't1',
      't2',
    ]);

    const second = weeks[1];
    const cont = second.bands.find((b) => b.entry.item.id === 'span');
    expect(cont).toMatchObject({ column: 0, span: 4, continuesBefore: true });
  });

  it('derives a stable tone from the group', () => {
    const a = toneFor({
      id: '1',
      title: 'x',
      start: '2026-01-01',
      group: 'council',
    });
    const b = toneFor({
      id: '2',
      title: 'y',
      start: '2026-01-01',
      group: 'council',
    });
    expect(a).toBe(b);
    expect(
      toneFor({ id: '3', title: 'z', start: '2026-01-01', tone: 'error' }),
    ).toBe('error');
  });
});
