import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventCollection } from '../collections/EventCollection';
import { EventSeriesCollection } from '../collections/EventSeriesCollection';
import { Event } from '../models/Event';
import { syncICalendarSource } from './sync';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const fixture = (sequence = 1, status = 'CONFIRMED') => `BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:a\r
DTSTART:20261005T190000Z\r
SEQUENCE:${sequence}\r
STATUS:${status}\r
SUMMARY:First\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:b\r
DTSTART:20261006T190000Z\r
SEQUENCE:${sequence}\r
STATUS:${status}\r
SUMMARY:Second\r
END:VEVENT\r
END:VCALENDAR\r
`;

for (const dialect of ['sqlite', 'postgres'] as const) {
  describe.skipIf(dialect === 'postgres' && !pgUrl)(
    `calendar atomicity ${dialect}`,
    () => {
      afterEach(() => {
        vi.restoreAllMocks();
        disableTenancy();
      });
      const database = () =>
        getTestDatabase({
          type: dialect,
          url: dialect === 'postgres' ? pgUrl : ':memory:',
          classes: ['Event', 'EventSeries', 'EventType'],
        });
      it('rolls back a second-event failure, then retries and repeats without duplicates', async () => {
        const db = await database();
        const source = randomUUID();
        const events = await EventCollection.create({ db });
        const series = await EventSeriesCollection.create({ db });
        const save = Event.prototype.save;
        let calls = 0;
        const injected = vi
          .spyOn(Event.prototype, 'save')
          .mockImplementation(async function (this: Event) {
            if (++calls === 2) throw new Error('injected second save failure');
            return save.call(this);
          });
        await expect(
          syncICalendarSource({ db, source, ics: fixture() }),
        ).rejects.toThrow('injected');
        injected.mockRestore();
        expect(await events.list({ where: { source } })).toHaveLength(0);
        expect(await series.list({ where: { source } })).toHaveLength(0);
        expect(
          await syncICalendarSource({ db, source, ics: fixture() }),
        ).toMatchObject({ created: 2 });
        expect(
          await syncICalendarSource({ db, source, ics: fixture() }),
        ).toMatchObject({ unchanged: 2 });
        await db.close?.();
      });
      it('keeps writes on the caller transaction and rolls back with that caller', async () => {
        const db = await database();
        const source = randomUUID();
        if (!db.transaction) throw new Error('transaction required');
        await expect(
          db.transaction(async (tx) => {
            await syncICalendarSource({ db: tx, source, ics: fixture() });
            const local = await EventCollection.create({ db: tx });
            expect(await local.list({ where: { source } })).toHaveLength(2);
            throw new Error('caller rollback');
          }),
        ).rejects.toThrow('caller rollback');
        const events = await EventCollection.create({ db });
        expect(await events.list({ where: { source } })).toHaveLength(0);
        await db.close?.();
      });
      it('enforces actor/tenant context and separates tenant, global and source identities', async () => {
        const db = await database();
        const source = randomUUID();
        const tenantA = randomUUID();
        const tenantB = randomUUID();
        enableTenancy();
        await withTenant({ tenantId: tenantA }, async () => {
          expect(
            await syncICalendarSource({ db, source, ics: fixture() }),
          ).toMatchObject({ created: 2 });
          await expect(
            syncICalendarSource({
              db,
              source,
              tenantId: tenantB,
              ics: fixture(),
            }),
          ).rejects.toThrow('isolation');
          await expect(
            syncICalendarSource({ db, source, tenantId: null, ics: fixture() }),
          ).rejects.toThrow('isolation');
        });
        await withTenant({ tenantId: tenantB }, () =>
          syncICalendarSource({ db, source, ics: fixture() }),
        );
        await withSystemContext(async () => {
          await syncICalendarSource({ db, source, ics: fixture() });
          await syncICalendarSource({
            db,
            source: `${source}-other`,
            tenantId: tenantA,
            ics: fixture(),
          });
          const events = await EventCollection.create({ db });
          const rows = await events.list({ where: { source } });
          expect(rows).toHaveLength(6);
          expect(new Set(rows.map((e) => e.id)).size).toBe(6);
          expect(new Set(rows.map((e) => e.seriesId)).size).toBe(6);
        });
        await db.close?.();
      });
      it('retains omissions and old versions, then restores a cancelled reappearance', async () => {
        const db = await database();
        const source = randomUUID();
        await syncICalendarSource({ db, source, ics: fixture() });
        const events = await EventCollection.create({ db });
        const ids = (await events.list({ where: { source } }))
          .map((e) => e.id)
          .sort();
        await syncICalendarSource({ db, source, ics: fixture(2, 'CANCELLED') });
        await syncICalendarSource({
          db,
          source,
          ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
        });
        expect(
          await syncICalendarSource({ db, source, ics: fixture() }),
        ).toMatchObject({ unchanged: 2 });
        expect(
          (await events.list({ where: { source } })).every(
            (e) => e.status === 'cancelled',
          ),
        ).toBe(true);
        expect(
          await syncICalendarSource({ db, source, ics: fixture(3) }),
        ).toMatchObject({ updated: 2 });
        expect(
          (await events.list({ where: { source } })).map((e) => e.id).sort(),
        ).toEqual(ids);
        expect(
          await syncICalendarSource({
            db,
            source,
            ics: fixture(1, 'CANCELLED').replaceAll(
              'BEGIN:VEVENT\r\n',
              'BEGIN:VEVENT\r\nDTSTAMP:20261009T190000Z\r\n',
            ),
          }),
        ).toMatchObject({ updated: 2 });
        await db.close?.();
      });
    },
  );
}

for (const dialect of ['sqlite', 'postgres'] as const) {
  describe.skipIf(dialect === 'postgres' && !pgUrl)(
    `recurrence persistence lifecycle ${dialect}`,
    () => {
      const database = () =>
        getTestDatabase({
          type: dialect,
          url: dialect === 'postgres' ? pgUrl : ':memory:',
          classes: ['Event', 'EventSeries', 'EventType'],
        });
      const window = {
        rangeStart: new Date('2026-10-01Z'),
        rangeEnd: new Date('2026-11-01Z'),
      };
      const recurring = (
        sequence: number,
        excluded = true,
      ) => `BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:series\r
DTSTART:20261005T190000Z\r
DTEND:20261005T210000Z\r
RRULE:FREQ=WEEKLY;COUNT=3\r
${excluded ? 'EXDATE:20261012T190000Z\r\n' : ''}SEQUENCE:${sequence}\r
SUMMARY:Meeting\r
END:VEVENT\r
END:VCALENDAR\r
`;
      it('updates slots without master duplicates; EXDATE removal restores the same slot', async () => {
        const db = await database();
        const source = randomUUID();
        expect(
          await syncICalendarSource({
            db,
            source,
            ics: recurring(1),
            expansion: window,
          }),
        ).toMatchObject({ created: 3 });
        const events = await EventCollection.create({ db });
        const before = await events.list({ where: { source } });
        expect(before.filter((e) => e.status === 'cancelled')).toHaveLength(1);
        expect(
          await syncICalendarSource({
            db,
            source,
            ics: recurring(2, false),
            expansion: window,
          }),
        ).toMatchObject({ updated: 3 });
        const after = await events.list({ where: { source } });
        expect(after.every((e) => e.status === 'scheduled')).toBe(true);
        expect(after.map((e) => e.id).sort()).toEqual(
          before.map((e) => e.id).sort(),
        );
        await db.close?.();
      });
      it('retains omitted detached exceptions and restores a moved exception with its original ID', async () => {
        const db = await database();
        const source = randomUUID();
        const detached = (sequence: number, status: string) =>
          `BEGIN:VEVENT\r\nUID:series\r\nRECURRENCE-ID:20261012T190000Z\r\nDTSTART:20261013T200000Z\r\nSEQUENCE:${sequence}\r\nSTATUS:${status}\r\nSUMMARY:Exception\r\nEND:VEVENT\r\n`;
        const feed = recurring(1, false).replace(
          'END:VCALENDAR',
          detached(2, 'CANCELLED') + 'END:VCALENDAR',
        );
        await syncICalendarSource({ db, source, ics: feed, expansion: window });
        const events = await EventCollection.create({ db });
        const cancelled = (await events.list({ where: { source } })).find(
          (e) => e.status === 'cancelled',
        );
        expect(cancelled).toBeDefined();
        await syncICalendarSource({
          db,
          source,
          ics: recurring(3, false),
          expansion: window,
        });
        expect((await events.get({ id: cancelled?.id }))?.status).toBe(
          'cancelled',
        );
        const restored = recurring(3, false).replace(
          'END:VCALENDAR',
          detached(4, 'CONFIRMED') + 'END:VCALENDAR',
        );
        await syncICalendarSource({
          db,
          source,
          ics: restored,
          expansion: window,
        });
        const row = await events.get({ id: cancelled?.id });
        expect(row?.status).toBe('scheduled');
        expect(row?.startDate?.toISOString()).toBe('2026-10-13T20:00:00.000Z');
        expect(await events.list({ where: { source } })).toHaveLength(3);
        await db.close?.();
      });
      it('cancels an entire known series with a minimal notice and prevents stale resurrection', async () => {
        const db = await database();
        const source = randomUUID();
        await syncICalendarSource({
          db,
          source,
          ics: recurring(1),
          expansion: window,
        });
        const notice =
          'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:series\r\nSTATUS:CANCELLED\r\nSEQUENCE:3\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
        await syncICalendarSource({ db, source, ics: notice });
        const events = await EventCollection.create({ db });
        expect(
          (await events.list({ where: { source } })).every(
            (e) => e.status === 'cancelled',
          ),
        ).toBe(true);
        await syncICalendarSource({
          db,
          source,
          ics: recurring(2, false),
          expansion: window,
        });
        expect(
          (await events.list({ where: { source } })).every(
            (e) => e.status === 'cancelled',
          ),
        ).toBe(true);
        await syncICalendarSource({
          db,
          source,
          ics: recurring(4, false),
          expansion: window,
        });
        expect(
          (await events.list({ where: { source } })).filter(
            (e) => e.startDate && e.status === 'scheduled',
          ),
        ).toHaveLength(3);
        await db.close?.();
      });
    },
  );
}

it.each([
  'duckdb',
  'json',
] as const)('rejects %s runtime-schema adapters before mutation', async (dialect) => {
  const { getDatabase } = await import('@happyvertical/sql');
  const directory = await mkdtemp(join(tmpdir(), 'calendar-unsupported-'));
  const db = await getDatabase({
    type: dialect,
    url: dialect === 'json' ? directory : ':memory:',
  });
  const transaction = vi.spyOn(db, 'transaction');
  await expect(
    syncICalendarSource({ db, source: 'unsupported', ics: fixture() }),
  ).rejects.toThrow('migrated SQLite/PostgreSQL');
  expect(transaction).not.toHaveBeenCalled();
  transaction.mockRestore();
  await db.close?.();
  await rm(directory, { recursive: true, force: true });
});
