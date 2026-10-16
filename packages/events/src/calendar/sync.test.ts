import { afterEach, describe, expect, it } from 'vitest';
import { createOwnedSqliteFixtures } from '../__tests__/owned-sqlite-fixtures.js';
import { EventCollection } from '../collections/EventCollection.js';
import { syncICalendarSource } from './sync.js';

const fixtures = createOwnedSqliteFixtures();

const ics = (
  sequence: number,
  status = 'CONFIRMED',
  stamp = '20261001T120000Z',
) => `BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:meeting@example.test\r
DTSTAMP:${stamp}\r
SEQUENCE:${sequence}\r
DTSTART;TZID=America/Edmonton:20261005T190000\r
DTEND;TZID=America/Edmonton:20261005T210000\r
STATUS:${status}\r
SUMMARY:Council\r
END:VEVENT\r
END:VCALENDAR\r
`;

async function db() {
  const events = await EventCollection.create({
    db: {
      type: 'sqlite' as const,
      url: fixtures.url('calendar'),
    },
  });
  fixtures.track(events.db);
  return events.db;
}

afterEach(() => fixtures.cleanup());

describe('syncICalendarSource', () => {
  it('is identity-idempotent, version ordered, and never deletes by feed omission', async () => {
    const database = await db();
    expect(
      await syncICalendarSource({ db: database, source: 'town', ics: ics(1) }),
    ).toMatchObject({ created: 1, retainedOnOmission: true });
    expect(
      await syncICalendarSource({ db: database, source: 'town', ics: ics(1) }),
    ).toMatchObject({ unchanged: 1 });
    expect(
      await syncICalendarSource({
        db: database,
        source: 'town',
        ics: ics(2, 'CANCELLED'),
      }),
    ).toMatchObject({ updated: 1 });
    const events = await EventCollection.create({ db: database });
    const [event] = await events.list({});
    expect(event).toMatchObject({
      source: 'town',
      externalId: 'meeting@example.test',
      status: 'cancelled',
      tenantId: null,
    });
  });

  it('keeps tenant identities isolated and accepts newer DTSTAMP with lower sequence', async () => {
    const database = await db();
    await syncICalendarSource({
      db: database,
      source: 'town',
      tenantId: 'tenant-a',
      ics: ics(2),
    });
    await syncICalendarSource({
      db: database,
      source: 'town',
      tenantId: 'tenant-b',
      ics: ics(2),
    });
    expect(
      await syncICalendarSource({
        db: database,
        source: 'town',
        tenantId: 'tenant-a',
        ics: ics(1, 'CANCELLED', '20261002T120000Z'),
      }),
    ).toMatchObject({ updated: 1 });
    const events = await EventCollection.create({ db: database });
    const rows = await events.list({});
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((event) => event.seriesId)).size).toBe(2);
  });
});
