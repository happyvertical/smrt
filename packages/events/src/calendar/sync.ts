import { createHash } from 'node:crypto';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { EventCollection } from '../collections/EventCollection';
import { EventSeriesCollection } from '../collections/EventSeriesCollection';
import type { Event } from '../models/Event';
import { type CalendarEventInput, parseICalendarEvents } from './icalendar';

export interface CalendarSourceSyncOptions extends SmrtClassOptions {
  source: string;
  ics: string;
  tenantId?: string | null;
}

export interface CalendarSourceSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Missing feed entries are deliberately retained; sync never deletes by omission. */
  retainedOnOmission: true;
}

type TransactionalDatabase = DatabaseInterface & {
  transaction?<T>(work: (db: DatabaseInterface) => Promise<T>): Promise<T>;
};

interface CalendarVersion {
  sequence: number | null;
  dtstamp: string | null;
}

function stableId(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\u001f')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function identityKey(entry: CalendarEventInput): string {
  return entry.identity.recurrenceId
    ? `${entry.identity.uid}\u001f${entry.identity.recurrenceId}`
    : entry.identity.uid;
}

function versionFrom(event: Event): CalendarVersion {
  const calendar = event.getMetadata().calendar;
  if (!calendar || typeof calendar !== 'object')
    return { sequence: null, dtstamp: null };
  const record = calendar as Record<string, unknown>;
  return {
    sequence: typeof record.sequence === 'number' ? record.sequence : null,
    dtstamp: typeof record.dtstamp === 'string' ? record.dtstamp : null,
  };
}

function isNewer(entry: CalendarEventInput, existing: Event): boolean {
  const previous = versionFrom(existing);
  const sequence = entry.sequence ?? 0;
  const oldSequence = previous.sequence ?? 0;
  if (sequence > oldSequence) return true;
  const stamp = entry.dtstamp?.toISOString() ?? '';
  const oldStamp = previous.dtstamp ?? '';
  return stamp > oldStamp;
}

function applyEvent(
  event: Event,
  entry: CalendarEventInput,
  seriesId: string,
  tenantId: string | null,
): void {
  event.tenantId = tenantId;
  event.seriesId = seriesId;
  event.name = entry.name;
  event.description = entry.description;
  event.startDate = entry.startDate;
  event.endDate = entry.endDate;
  event.allDay = entry.allDay;
  event.timeZone = entry.timeZone;
  event.status = entry.status;
  event.source = entry.identity.source;
  event.externalId = entry.identity.uid;
  event.setMetadata({
    ...event.getMetadata(),
    calendar: {
      uid: entry.identity.uid,
      recurrenceId: entry.identity.recurrenceId ?? null,
      sequence: entry.sequence,
      dtstamp: entry.dtstamp?.toISOString() ?? null,
      rrule: entry.recurrence,
      exdate: entry.excludedRecurrenceIds,
      rdate: entry.additionalRecurrenceIds,
    },
  });
}

async function syncParsed(
  db: DatabaseInterface,
  options: CalendarSourceSyncOptions,
): Promise<CalendarSourceSyncResult> {
  const entries = parseICalendarEvents(options.source, options.ics);
  const events = await EventCollection.create({ db });
  const series = await EventSeriesCollection.create({ db });
  const tenantId = options.tenantId ?? null;
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const entry of entries) {
    const seriesId = stableId(
      'icalendar-series',
      tenantId ?? '',
      options.source,
      entry.identity.uid,
    );
    let sourceSeries = await series.get({ id: seriesId });
    if (!sourceSeries) {
      sourceSeries = await series.create({
        id: seriesId,
        tenantId,
        name: entry.name,
        source: options.source,
        externalId: entry.identity.uid,
      });
      sourceSeries.setMetadata({ calendar: { uid: entry.identity.uid } });
      await sourceSeries.save();
    }

    const id = stableId(
      'icalendar-event',
      tenantId ?? '',
      options.source,
      identityKey(entry),
    );
    const existing = await events.get({ id });
    if (existing && !isNewer(entry, existing)) {
      unchanged += 1;
      continue;
    }
    const event = existing ?? (await events.create({ id }));
    applyEvent(event, entry, seriesId, tenantId);
    await event.save();
    if (existing) updated += 1;
    else created += 1;
  }

  return { created, updated, unchanged, retainedOnOmission: true };
}

/**
 * Persist one already-fetched calendar feed. The caller owns fetch, retries and
 * authorization; every write runs through its database transaction when one is
 * available. Feed omission never deletes an existing event.
 */
export async function syncICalendarSource(
  options: CalendarSourceSyncOptions,
): Promise<CalendarSourceSyncResult> {
  if (!options.db) throw new Error('Calendar source sync requires a database');
  const db = options.db as TransactionalDatabase;
  return db.transaction
    ? db.transaction((transaction) => syncParsed(transaction, options))
    : syncParsed(db, options);
}
