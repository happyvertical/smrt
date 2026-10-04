import { describe, expect, it } from 'vitest';
import {
  CalendarEventValidationError,
  expandICalendarEvents,
  parseICalendarEvents,
} from './icalendar.js';

const recurringFixture = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:town-council@example.test\r
DTSTAMP:20261001T120000Z\r
SEQUENCE:3\r
DTSTART;TZID=America/Edmonton:20261005T190000\r
DTEND;TZID=America/Edmonton:20261005T210000\r
RRULE:FREQ=WEEKLY;COUNT=4\r
EXDATE;TZID=America/Edmonton:20261012T190000\r
RDATE;TZID=America/Edmonton:20261013T190000\r
SUMMARY:Town council\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:town-council@example.test\r
RECURRENCE-ID;TZID=America/Edmonton:20261019T190000\r
DTSTAMP:20261002T120000Z\r
SEQUENCE:4\r
STATUS:CANCELLED\r
DTSTART;TZID=America/Edmonton:20261019T190000\r
DTEND;TZID=America/Edmonton:20261019T210000\r
SUMMARY:Town council\r
END:VEVENT\r
END:VCALENDAR\r
`;

describe('parseICalendarEvents', () => {
  it('preserves source/UID identities and recurrence exceptions', () => {
    const [master, detached] = parseICalendarEvents(
      'town-calendar',
      recurringFixture,
    );

    expect(master).toMatchObject({
      identity: { source: 'town-calendar', uid: 'town-council@example.test' },
      allDay: false,
      timeZone: 'America/Edmonton',
      status: 'scheduled',
      sequence: 3,
      recurrence: 'FREQ=WEEKLY;COUNT=4',
      excludedRecurrenceIds: ['2026-10-13T01:00:00.000Z'],
      additionalRecurrenceIds: ['2026-10-14T01:00:00.000Z'],
    });
    expect(detached).toMatchObject({
      identity: {
        source: 'town-calendar',
        uid: 'town-council@example.test',
        recurrenceId: '2026-10-20T01:00:00.000Z',
      },
      status: 'cancelled',
      sequence: 4,
    });
  });

  it('requires a non-empty source and VEVENT UID', () => {
    expect(() => parseICalendarEvents('', recurringFixture)).toThrow(
      CalendarEventValidationError,
    );
    expect(() =>
      parseICalendarEvents(
        'town-calendar',
        'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
      ),
    ).toThrow('VEVENT UID is required');
  });
  it('accepts RFC 5545 all-day DATE values', () => {
    expect(
      parseICalendarEvents(
        'town',
        'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:day\r\nDTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261006\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
      )[0].allDay,
    ).toBe(true);
  });

  it('does not infer a source policy for floating DTSTART values', () => {
    expect(() =>
      parseICalendarEvents(
        'town-calendar',
        'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:floating\r\nDTSTART:20261005T190000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
      ),
    ).toThrow('Floating DTSTART requires an explicit source time-zone policy');
  });
});

describe('bounded calendar expansion', () => {
  const window = {
    rangeStart: new Date('2026-10-01Z'),
    rangeEnd: new Date('2026-11-10Z'),
  };
  it('deduplicates RDATE and replaces detached and excluded instances, across DST', () => {
    const input = recurringFixture
      .replaceAll('America/Edmonton', 'America/New_York')
      .replace('COUNT=4', 'COUNT=6')
      .replace('20261013T190000', '20261013T190000,20261005T190000');
    const events = expandICalendarEvents('town', input, window);
    expect(events.map((e) => e.identity.recurrenceId)).toEqual([
      '2026-10-05T23:00:00.000Z',
      '2026-10-12T23:00:00.000Z',
      '2026-10-13T23:00:00.000Z',
      '2026-10-19T23:00:00.000Z',
      '2026-10-26T23:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
      '2026-11-10T00:00:00.000Z',
    ]);
    expect(new Set(events.map((e) => e.identity.recurrenceId)).size).toBe(7);
    expect(events.filter((e) => e.status === 'cancelled')).toHaveLength(2);
    expect(
      events
        .find((e) => e.identity.recurrenceId === '2026-11-03T00:00:00.000Z')
        ?.startDate?.toISOString(),
    ).toBe('2026-11-03T00:00:00.000Z');
    expect(events[0].startDate?.toISOString()).toBe('2026-10-05T23:00:00.000Z');
  });
  it('keeps the original identity when an exception moves out of the window', () => {
    const moved = recurringFixture
      .replaceAll('America/Edmonton', 'America/New_York')
      .replace('STATUS:CANCELLED', 'STATUS:CONFIRMED')
      .replace(
        'DTSTART;TZID=America/New_York:20261019T190000',
        'DTSTART;TZID=America/New_York:20261219T190000',
      )
      .replace(
        'DTEND;TZID=America/New_York:20261019T210000',
        'DTEND;TZID=America/New_York:20261219T210000',
      );
    const event = expandICalendarEvents('town', moved, window).find(
      (e) => e.identity.recurrenceId === '2026-10-19T23:00:00.000Z',
    );
    expect(event?.startDate?.toISOString()).toBe('2026-12-20T00:00:00.000Z');
  });
  it('applies an explicit floating policy and exclusive all-day boundaries', () => {
    const floating =
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:day\r\nDTSTART:20261101T013000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    expect(
      parseICalendarEvents('town', floating, {
        floatingTimeZone: 'America/New_York',
      })[0].startDate?.toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z');
    const day = floating.replace(
      'DTSTART:20261101T013000',
      'DTSTART;VALUE=DATE:20261101',
    );
    const [event] = parseICalendarEvents('town', day, {
      floatingTimeZone: 'America/New_York',
    });
    expect(event.startDate?.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(event.endDate?.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(() =>
      parseICalendarEvents('town', floating, { floatingTimeZone: 'Not/AZone' }),
    ).toThrow('Unknown IANA');
  });
  it('rejects caps and unsupported recurrence without partial results', () => {
    expect(() =>
      expandICalendarEvents('town', recurringFixture, { ...window, limit: 1 }),
    ).toThrow('occurrence limit');
    expect(() =>
      expandICalendarEvents('town', recurringFixture, {
        ...window,
        maxIterations: 1,
      }),
    ).toThrow('iteration limit');
    expect(() =>
      expandICalendarEvents(
        'town',
        recurringFixture.replace('WEEKLY', 'SECONDLY'),
        window,
      ),
    ).toThrow('Unsupported');
    expect(() =>
      parseICalendarEvents(
        'town',
        recurringFixture.replace('STATUS:CANCELLED', 'STATUS:ALIEN'),
      ),
    ).toThrow('STATUS');
    expect(() =>
      parseICalendarEvents('town', recurringFixture, {
        limits: { maxInputBytes: 8 },
      }),
    ).toThrow();
  });
});

it('normalizes UTC exceptions against IANA masters and applies UNTIL as an instant', () => {
  const feed = `BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:mixed\r
DTSTART;TZID=America/New_York:20261005T190000\r
RRULE:FREQ=WEEKLY;UNTIL=20261012T220000Z\r
RDATE;TZID=America/New_York:20261019T190000\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:mixed\r
RECURRENCE-ID:20261019T230000Z\r
DTSTART:20261020T230000Z\r
SUMMARY:Moved\r
END:VEVENT\r
END:VCALENDAR\r
`;
  const events = expandICalendarEvents('town', feed, {
    rangeStart: new Date('2026-10-01Z'),
    rangeEnd: new Date('2026-11-01Z'),
  });
  expect(events).toHaveLength(2);
  expect(events[1].identity.recurrenceId).toBe('2026-10-19T23:00:00.000Z');
  expect(events[1].name).toBe('Moved');
});

it('rejects malformed and unsupported external values before returning events', () => {
  const window = {
    rangeStart: new Date('2026-10-01Z'),
    rangeEnd: new Date('2026-11-01Z'),
  };
  expect(() =>
    expandICalendarEvents(
      'town',
      recurringFixture.replace('COUNT=4', 'COUNT=-1'),
      window,
    ),
  ).toThrow();
  expect(() =>
    expandICalendarEvents(
      'town',
      recurringFixture.replace('COUNT=4', 'BOGUS=4'),
      window,
    ),
  ).toThrow('Unsupported');
  expect(() =>
    parseICalendarEvents(
      'town',
      recurringFixture.replace('SEQUENCE:3', 'SEQUENCE:-1'),
    ),
  ).toThrow('SEQUENCE');
  expect(() => parseICalendarEvents('town', 'not a calendar')).toThrow();
  expect(() =>
    parseICalendarEvents(
      'town',
      recurringFixture.replace('RRULE:', 'DURATION:PT1H\r\nRRULE:'),
    ),
  ).toThrow('Unsupported');
});

it.each([
  [
    'FREQ=MONTHLY;COUNT=3;BYMONTHDAY=5',
    ['2026-10-05', '2026-11-05', '2026-12-05'],
  ],
  ['FREQ=YEARLY;COUNT=2;BYMONTH=10;BYMONTHDAY=5', ['2026-10-05', '2027-10-05']],
])('expands the supported %s subset with all-day exclusive ends', (rule, expected) => {
  const feed = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:day\r\nDTSTART;VALUE=DATE:20261005\r\nRRULE:${rule}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const events = expandICalendarEvents('town', feed, {
    rangeStart: new Date('2026-01-01Z'),
    rangeEnd: new Date('2028-01-01Z'),
  });
  expect(events.map((event) => event.identity.recurrenceId)).toEqual(expected);
  expect(
    events.every(
      (event) =>
        event.endDate!.getTime() - event.startDate!.getTime() === 86400000,
    ),
  ).toBe(true);
});

it('fails closed for contracting combinations that could search forever inside the SDK', () => {
  expect(() =>
    expandICalendarEvents(
      'town',
      recurringFixture.replace(
        'FREQ=WEEKLY;COUNT=4',
        'FREQ=DAILY;INTERVAL=7;BYDAY=TU',
      ),
      {
        rangeStart: new Date('2026-10-01Z'),
        rangeEnd: new Date('2026-11-01Z'),
      },
    ),
  ).toThrow('Unsupported recurrence combination');
});

it('retains exact timed duration across a DST transition', () => {
  const feed =
    'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:dst\r\nDTSTART;TZID=America/New_York:20260301T013000\r\nDTEND;TZID=America/New_York:20260301T033000\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const events = expandICalendarEvents('town', feed, {
    rangeStart: new Date('2026-03-01Z'),
    rangeEnd: new Date('2026-03-10Z'),
  });
  expect(events).toHaveLength(2);
  expect(events[1].startDate?.toISOString()).toBe('2026-03-08T06:30:00.000Z');
  expect(events[1].endDate?.toISOString()).toBe('2026-03-08T08:30:00.000Z');
});
