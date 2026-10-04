import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';
import { EventCollection } from '../collections/EventCollection';
import { EventSeriesCollection } from '../collections/EventSeriesCollection';
import { Event } from '../models/Event';
import { expandICalendarEvents } from './icalendar';
import { syncICalendarSource } from './sync';

const feed = (events: string) =>
  `BEGIN:VCALENDAR\r\n${events}END:VCALENDAR\r\n`;
const event = (properties: string) =>
  `BEGIN:VEVENT\r\n${properties}\r\nEND:VEVENT\r\n`;
const window = {
  rangeStart: new Date('2026-10-01Z'),
  rangeEnd: new Date('2026-10-31Z'),
};

it('F1 rejects monthly BYMONTHDAY+BYSETPOS while retaining exact supported slots', () => {
  const master = event(
    'UID:monthly\r\nDTSTART:20261005T190000Z\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=5,10',
  );
  expect(
    expandICalendarEvents('town', feed(master), window).map((e) =>
      e.startDate?.toISOString(),
    ),
  ).toEqual(['2026-10-05T19:00:00.000Z', '2026-10-10T19:00:00.000Z']);
  expect(() =>
    expandICalendarEvents(
      'town',
      feed(master.replace('BYMONTHDAY=5,10', 'BYMONTHDAY=5,10;BYSETPOS=1')),
      window,
    ),
  ).toThrow('Unsupported recurrence combination');
});

it('F2 normalizes each RDATE zone, deduplicates instants and replaces detached slots', () => {
  const master = event(
    'UID:zones\r\nDTSTART;TZID=America/New_York:20261005T190000\r\nRRULE:FREQ=DAILY;COUNT=2\r\nRDATE;TZID=America/Los_Angeles:20261006T190000\r\nRDATE:20261007T020000Z',
  );
  const onlyLosAngeles = master.replace('RDATE:20261007T020000Z\r\n', '');
  expect(
    expandICalendarEvents('town', feed(onlyLosAngeles), window).map(
      (e) => e.identity.recurrenceId,
    ),
  ).toEqual([
    '2026-10-05T23:00:00.000Z',
    '2026-10-06T23:00:00.000Z',
    '2026-10-07T02:00:00.000Z',
  ]);
  const slots = expandICalendarEvents('town', feed(master), window);
  expect(slots.map((e) => e.identity.recurrenceId)).toEqual([
    '2026-10-05T23:00:00.000Z',
    '2026-10-06T23:00:00.000Z',
    '2026-10-07T02:00:00.000Z',
  ]);
  const detached = event(
    'UID:zones\r\nRECURRENCE-ID;TZID=America/Los_Angeles:20261006T190000\r\nDTSTART:20261007T030000Z\r\nSUMMARY:Moved',
  );
  const replaced = expandICalendarEvents(
    'town',
    feed(master + detached),
    window,
  );
  expect(replaced).toHaveLength(3);
  expect(
    replaced.find(
      (e) => e.identity.recurrenceId === '2026-10-07T02:00:00.000Z',
    ),
  ).toMatchObject({
    name: 'Moved',
    startDate: new Date('2026-10-07T03:00:00Z'),
  });
});

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
for (const dialect of ['sqlite', 'postgres'] as const) {
  describe.skipIf(dialect === 'postgres' && !pgUrl)(
    `F3 authoritative series ${dialect}`,
    () => {
      it('expands unseen slots from the retained master instead of stale or equal incoming payload', async () => {
        const db = await getTestDatabase({
          type: dialect,
          url: dialect === 'postgres' ? pgUrl : ':memory:',
          classes: ['Event', 'EventSeries', 'EventType'],
        });
        const source = randomUUID();
        const master = (
          sequence: number,
          name: string,
          recurrence: string,
          status = 'CONFIRMED',
        ) =>
          feed(
            event(
              `UID:series\r\nDTSTART:20261005T190000Z\r\nSEQUENCE:${sequence}\r\nSUMMARY:${name}\r\nSTATUS:${status}\r\nRRULE:${recurrence}`,
            ),
          );
        const initial = {
          rangeStart: new Date('2026-10-01Z'),
          rangeEnd: new Date('2026-10-06Z'),
        };
        const later = {
          rangeStart: new Date('2026-10-10Z'),
          rangeEnd: new Date('2026-10-14Z'),
        };
        await syncICalendarSource({
          db,
          source,
          ics: master(10, 'Authoritative', 'FREQ=WEEKLY;COUNT=3'),
          expansion: initial,
        });
        const fail = vi
          .spyOn(Event.prototype, 'save')
          .mockRejectedValueOnce(new Error('rejected newer master'));
        await expect(
          syncICalendarSource({
            db,
            source,
            ics: master(11, 'Rejected', 'FREQ=DAILY;COUNT=20'),
            expansion: later,
          }),
        ).rejects.toThrow('rejected newer master');
        fail.mockRestore();
        await syncICalendarSource({
          db,
          source,
          ics: master(9, 'Stale', 'FREQ=DAILY;COUNT=20', 'CANCELLED'),
          expansion: later,
        });
        const events = await EventCollection.create({ db });
        const rows = await events.list({ where: { source } });
        expect(rows.map((e) => e.startDate?.toISOString()).sort()).toEqual([
          '2026-10-05T19:00:00.000Z',
          '2026-10-12T19:00:00.000Z',
        ]);
        expect(
          rows.every(
            (e) => e.name === 'Authoritative' && e.status === 'scheduled',
          ),
        ).toBe(true);
        const calendar = (
          await (
            await EventSeriesCollection.create({ db })
          ).list({ where: { source } })
        )[0].getMetadata().calendar;
        expect(calendar).toMatchObject({ sequence: 10 });
        await syncICalendarSource({
          db,
          source,
          ics: master(10, 'Equal changed payload', 'FREQ=DAILY;COUNT=20'),
          expansion: {
            rangeStart: new Date('2026-10-18Z'),
            rangeEnd: new Date('2026-10-21Z'),
          },
        });
        expect(
          (await events.list({ where: { source } })).map((e) => e.name),
        ).toEqual(['Authoritative', 'Authoritative', 'Authoritative']);
        const emptySource = randomUUID();
        await syncICalendarSource({
          db,
          source: emptySource,
          ics: master(10, 'Retained before first slot', 'FREQ=WEEKLY;COUNT=3'),
          expansion: {
            rangeStart: new Date('2026-09-01Z'),
            rangeEnd: new Date('2026-09-02Z'),
          },
        });
        expect(
          await events.list({ where: { source: emptySource } }),
        ).toHaveLength(0);
        await syncICalendarSource({
          db,
          source: emptySource,
          ics: master(9, 'Stale', 'FREQ=DAILY;COUNT=20'),
          expansion: later,
        });
        expect(
          (await events.list({ where: { source: emptySource } })).map(
            (e) => e.name,
          ),
        ).toEqual(['Retained before first slot']);
        await db.close?.();
      });
    },
  );
}
