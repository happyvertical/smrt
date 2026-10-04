import { describe, expect, it } from 'vitest';
import {
  CalendarEventValidationError,
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
      excludedRecurrenceIds: ['2026-10-12T19:00:00'],
      additionalRecurrenceIds: ['2026-10-13T19:00:00'],
    });
    expect(detached).toMatchObject({
      identity: {
        source: 'town-calendar',
        uid: 'town-council@example.test',
        recurrenceId: '2026-10-19T19:00:00',
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
  it('does not infer a source policy for floating DTSTART values', () => {
    expect(() =>
      parseICalendarEvents(
        'town-calendar',
        'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:floating\r\nDTSTART:20261005T190000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
      ),
    ).toThrow('Floating DTSTART requires an explicit source time-zone policy');
  });
});
