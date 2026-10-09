import { createHash } from 'node:crypto';
import { ICAL, parseICalendar } from '@happyvertical/icalendar';
import {
  type DatabaseConfig,
  resolveDatabase,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { EventCollection } from '../collections/EventCollection';
import { EventSeriesCollection } from '../collections/EventSeriesCollection';
import type { Event } from '../models/Event';
import {
  type CalendarEventInput,
  type CalendarExpansionOptions,
  type CalendarParseOptions,
  expandICalendarEvents,
  parseICalendarEvents,
} from './icalendar';

export interface CalendarSourceSyncOptions
  extends Omit<SmrtClassOptions, 'db'> {
  db: DatabaseConfig;
  source: string;
  ics: string;
  tenantId?: string | null;
  parse?: CalendarParseOptions;
  expansion?: Omit<CalendarExpansionOptions, keyof CalendarParseOptions>;
}

export interface CalendarSourceSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Missing feed entries are deliberately retained; sync never deletes by omission. */
  retainedOnOmission: true;
}

interface CalendarVersion {
  sequence: number | null;
  dtstamp: string | null;
}

function stableId(...parts: string[]): string {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function identityKey(entry: CalendarEventInput): string {
  return JSON.stringify([
    entry.identity.uid,
    entry.identity.recurrenceId ?? null,
  ]);
}

function versionFrom(event: Pick<Event, 'getMetadata'>): CalendarVersion {
  const calendar = event.getMetadata().calendar;
  if (!calendar || typeof calendar !== 'object')
    return { sequence: null, dtstamp: null };
  const record = calendar as Record<string, unknown>;
  return {
    sequence: typeof record.sequence === 'number' ? record.sequence : null,
    dtstamp: typeof record.dtstamp === 'string' ? record.dtstamp : null,
  };
}

function isNewer(
  entry: CalendarEventInput,
  existing: Pick<Event, 'getMetadata'>,
): boolean {
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
  event.name = entry.name || (entry.status === 'cancelled' ? event.name : '');
  event.description =
    entry.description ||
    (entry.status === 'cancelled' ? event.description : '');
  event.startDate = entry.startDate ?? event.startDate;
  event.endDate = entry.endDate ?? event.endDate;
  if (entry.startDate) {
    event.allDay = entry.allDay;
    event.timeZone = entry.timeZone;
  }
  event.status = entry.status;
  event.source = entry.identity.source;
  event.externalId = entry.identity.uid;
  event.setMetadata({
    ...event.getMetadata(),
    calendar: {
      uid: entry.identity.uid,
      detached: entry.detached ?? false,
      recurrenceId: entry.identity.recurrenceId ?? null,
      sequence: entry.sequence,
      dtstamp: entry.dtstamp?.toISOString() ?? null,
      rrule: entry.recurrence,
      exdate: entry.excludedRecurrenceIds,
      rdate: entry.additionalRecurrenceIds,
    },
  });
}

/** Retain one authoritative master document per series, even when the requested
 * window has no occurrences. Expand retained documents, never a stale payload.
 * This runs on the same transaction executor as occurrence materialization.
 */
async function retainCalendarMasters(
  series: EventSeriesCollection,
  options: CalendarSourceSyncOptions,
): Promise<string> {
  const parsed = parseICalendarEvents(
    options.source,
    options.ics,
    options.parse,
  );
  const components = parseICalendar(
    options.ics,
    options.parse?.limits,
  ).component.getAllSubcomponents('vevent');
  const calendar = new ICAL.Component('vcalendar');
  for (let index = 0; index < parsed.length; index++) {
    const entry = parsed[index];
    let component = components[index];
    if (!entry.detached) {
      const id = stableId(
        'icalendar-series',
        options.tenantId ?? '',
        options.source,
        entry.identity.uid,
      );
      let sourceSeries = await series.get({ id });
      if (!sourceSeries) {
        sourceSeries = await series.create({
          id,
          tenantId: options.tenantId ?? null,
          name: entry.name,
          source: options.source,
          externalId: entry.identity.uid,
        });
      }
      const previous = sourceSeries.getMetadata().calendar;
      const record =
        previous && typeof previous === 'object'
          ? (previous as Record<string, unknown>)
          : {};
      if (
        typeof record.masterIcs === 'string' &&
        !isNewer(entry, sourceSeries)
      ) {
        const retained = parseICalendar(
          record.masterIcs,
          options.parse?.limits,
        ).component.getFirstSubcomponent('vevent');
        if (!retained)
          throw new Error('Stored calendar master is missing VEVENT');
        component = retained;
      } else {
        // Bind floating values to their authoritative source policy before saving
        // the SDK component. Future window requests cannot reinterpret that policy.
        for (const propertyName of [
          'dtstart',
          'dtend',
          'recurrence-id',
          'rdate',
          'exdate',
        ]) {
          for (const property of component.getAllProperties(propertyName)) {
            const value = property.getFirstValue();
            if (
              value instanceof ICAL.Time &&
              !value.isDate &&
              value.zone.tzid === 'floating' &&
              !property.getFirstParameter('tzid') &&
              entry.timeZone
            ) {
              property.setParameter('tzid', entry.timeZone);
            }
          }
        }
        const document = new ICAL.Component('vcalendar');
        document.addSubcomponent(component);
        sourceSeries.name = entry.name || sourceSeries.name;
        sourceSeries.setMetadata({
          ...sourceSeries.getMetadata(),
          calendar: {
            uid: entry.identity.uid,
            sequence: entry.sequence,
            dtstamp: entry.dtstamp?.toISOString() ?? null,
            cancelled: entry.status === 'cancelled' && !entry.startDate,
            masterIcs: document.toString(),
          },
        });
        await sourceSeries.save();
      }
    }
    calendar.addSubcomponent(component);
  }
  return calendar.toString();
}

async function syncParsed(
  db: DatabaseInterface,
  options: CalendarSourceSyncOptions,
): Promise<CalendarSourceSyncResult> {
  const events = await EventCollection.create({ db });
  const series = await EventSeriesCollection.create({ db });
  const authoritativeIcs = await retainCalendarMasters(series, options);
  const entries = options.expansion
    ? expandICalendarEvents(options.source, authoritativeIcs, {
        ...options.parse,
        ...options.expansion,
      })
    : parseICalendarEvents(options.source, authoritativeIcs, options.parse);
  if (
    !options.expansion &&
    entries.some(
      (entry) => entry.recurrence || entry.additionalRecurrenceIds.length,
    )
  ) {
    throw new Error('Recurring calendar sync requires bounded expansion');
  }
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

    if (
      entry.status === 'cancelled' &&
      !entry.startDate &&
      !entry.identity.recurrenceId
    ) {
      const affected = await events.list({ where: { seriesId, tenantId } });
      for (const event of affected) {
        if (!isNewer(entry, event)) {
          unchanged++;
          continue;
        }
        event.status = 'cancelled';
        const calendar = event.getMetadata().calendar;
        event.setMetadata({
          ...event.getMetadata(),
          calendar: {
            ...(calendar && typeof calendar === 'object' ? calendar : {}),
            sequence: entry.sequence,
            dtstamp: entry.dtstamp?.toISOString() ?? null,
          },
        });
        await event.save();
        updated++;
      }
      if (
        !(
          'cancelled' in
          (sourceSeries.getMetadata().calendar as Record<string, unknown>)
        ) ||
        isNewer(entry, sourceSeries)
      ) {
        sourceSeries.setMetadata({
          ...sourceSeries.getMetadata(),
          calendar: {
            ...(sourceSeries.getMetadata().calendar as Record<string, unknown>),
            uid: entry.identity.uid,
            cancelled: true,
            sequence: entry.sequence,
            dtstamp: entry.dtstamp?.toISOString() ?? null,
          },
        });
        await sourceSeries.save();
      }
      continue;
    }

    const id = stableId(
      'icalendar-event',
      tenantId ?? '',
      options.source,
      identityKey(entry),
    );
    const existing = await events.get({ id });
    const sourceCalendar = sourceSeries.getMetadata().calendar;
    if (
      sourceCalendar &&
      typeof sourceCalendar === 'object' &&
      'cancelled' in sourceCalendar &&
      sourceCalendar.cancelled === true &&
      !isNewer(entry, sourceSeries)
    ) {
      unchanged++;
      continue;
    }
    const previousCalendar = existing?.getMetadata().calendar;
    const existingDetached =
      previousCalendar &&
      typeof previousCalendar === 'object' &&
      'detached' in previousCalendar &&
      previousCalendar.detached === true;
    if (
      existing &&
      ((existingDetached && !entry.detached) || !isNewer(entry, existing))
    ) {
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
 * authorization; every write runs through one required database transaction. Feed omission never deletes an existing event.
 */
export async function syncICalendarSource(
  options: CalendarSourceSyncOptions,
): Promise<CalendarSourceSyncResult> {
  if (!options.db) throw new Error('Calendar source sync requires a database');
  const activeTenant = getTenantId();
  const tenantId =
    options.tenantId === undefined ? (activeTenant ?? null) : options.tenantId;
  if (activeTenant && activeTenant !== tenantId)
    throw new Error('Calendar tenant isolation violation');
  const entries = parseICalendarEvents(
    options.source,
    options.ics,
    options.parse,
  );
  if (
    !options.expansion &&
    entries.some((e) => e.recurrence || e.additionalRecurrenceIds.length)
  ) {
    throw new Error('Recurring calendar sync requires bounded expansion');
  }
  const db = await resolveDatabase(options.db);
  if (db.requiresSchemaCheck)
    throw new Error(
      'Calendar sync requires migrated SQLite/PostgreSQL schemas',
    );
  if (!db.transaction)
    throw new Error('Calendar source sync requires transaction()');
  return db.transaction((transaction) =>
    syncParsed(transaction, { ...options, tenantId }),
  );
}
