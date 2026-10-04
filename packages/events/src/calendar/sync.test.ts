import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventCollection } from '../collections/EventCollection.js';
import { syncICalendarSource } from './sync.js';

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

function db() {
  return {
    type: 'sqlite' as const,
    url: `file:${join(tmpdir(), `calendar-${randomUUID()}.db`)}`,
  };
}

describe('syncICalendarSource', () => {
  it('is identity-idempotent, version ordered, and never deletes by feed omission', async () => {
    const database = db();
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
    const database = db();
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
    expect(await events.list({})).toHaveLength(2);
  });
});
