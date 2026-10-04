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

for (const dialect of ['sqlite', 'postgres'] as const) {
  it.skipIf(dialect === 'postgres' && !pgUrl)(
    `retained recurring master requires expansion atomically (${dialect})`,
    async () => {
      const db = await getTestDatabase({
        type: dialect,
        url: dialect === 'postgres' ? pgUrl : ':memory:',
        classes: ['Event', 'EventSeries', 'EventType'],
      });
      const source = randomUUID();
      const master = event(
        'UID:series\r\nDTSTART:20261005T190000Z\r\nSEQUENCE:10\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:Authoritative',
      );
      await syncICalendarSource({
        db,
        source,
        ics: feed(master),
        expansion: {
          rangeStart: new Date('2026-10-01Z'),
          rangeEnd: new Date('2026-10-06Z'),
        },
      });
      const events = await EventCollection.create({ db });
      const series = await EventSeriesCollection.create({ db });
      const beforeEvents = (await events.list({ where: { source } })).map((e) =>
        e.toJSON(),
      );
      const beforeSeries = (await series.list({ where: { source } })).map((e) =>
        e.toJSON(),
      );
      const notice = event('UID:series\r\nSTATUS:CANCELLED\r\nSEQUENCE:9');
      // This new master is retained first, proving the rejection rolls back even
      // writes made earlier in the same transaction while choosing authority.
      const fresh = event(
        'UID:fresh\r\nDTSTART:20261015T190000Z\r\nSUMMARY:Fresh',
      );
      await expect(
        syncICalendarSource({ db, source, ics: feed(fresh + notice) }),
      ).rejects.toThrow('requires bounded expansion');
      expect(
        (await events.list({ where: { source } })).map((e) => e.toJSON()),
      ).toEqual(beforeEvents);
      expect(
        (await series.list({ where: { source } })).map((e) => e.toJSON()),
      ).toEqual(beforeSeries);
      await syncICalendarSource({
        db,
        source,
        ics: feed(fresh + notice),
        expansion: window,
      });
      const recurring = (await events.list({ where: { source } })).filter(
        (e) => e.externalId === 'series',
      );
      expect(recurring).toHaveLength(3);
      expect(
        recurring.every(
          (e) =>
            e.status === 'scheduled' &&
            Boolean(
              (e.getMetadata().calendar as Record<string, unknown>)
                .recurrenceId,
            ),
        ),
      ).toBe(true);
      await syncICalendarSource({
        db,
        source,
        ics: feed(notice.replace('SEQUENCE:9', 'SEQUENCE:11')),
      });
      const cancelled = (await events.list({ where: { source } })).filter(
        (e) => e.externalId === 'series',
      );
      expect(cancelled).toHaveLength(3);
      expect(cancelled.every((e) => e.status === 'cancelled')).toBe(true);
      await db.close?.();
    },
  );
}
