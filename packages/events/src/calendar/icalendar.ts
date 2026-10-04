import {
  ICAL,
  type ICalendarComponent,
  type ICalendarParseLimits,
  parseICalendar,
} from '@happyvertical/icalendar';
import {
  fromZonedWallTime,
  isValidTimeZone,
  toZonedWallTime,
} from '../recurrence';

/** A stable upstream identity for a calendar master or detached occurrence. */
export interface CalendarEventIdentity {
  source: string;
  uid: string;
  recurrenceId?: string;
}

/** Parsed data SMRT needs before applying its persistence policy. */
export interface CalendarParseOptions {
  floatingTimeZone?: string;
  limits?: ICalendarParseLimits;
}

export interface CalendarEventInput {
  identity: CalendarEventIdentity;
  name: string;
  description: string;
  startDate: Date | null;
  endDate: Date | null;
  allDay: boolean;
  timeZone: string;
  status: 'scheduled' | 'cancelled';
  sequence: number | null;
  dtstamp: Date | null;
  recurrence: string | null;
  /** True for a detached record, false for a generated occurrence. */
  detached?: boolean;
  excludedRecurrenceIds: string[];
  additionalRecurrenceIds: string[];
}

/** A malformed calendar event cannot be given a stable source identity. */
export class CalendarEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarEventValidationError';
  }
}

type ICalendarTimeValue = InstanceType<typeof ICAL.Time>;

function readText(component: ICalendarComponent, name: string): string {
  const value = component.getFirstPropertyValue(name);
  if (typeof value === 'string') return value;
  return value && typeof value.toString === 'function' ? value.toString() : '';
}

function readNumber(
  component: ICalendarComponent,
  name: string,
): number | null {
  const value = component.getFirstPropertyValue(name);
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null;
}

function readTime(
  component: ICalendarComponent,
  name: string,
): ICalendarTimeValue | null {
  const value = component.getFirstPropertyValue(name);
  return value instanceof ICAL.Time ? value : null;
}

function timeZone(component: ICalendarComponent, name: string): string {
  const parameter = component.getFirstProperty(name)?.getFirstParameter('tzid');
  if (typeof parameter === 'string') return parameter;
  const value = readTime(component, name);
  const tzid = value?.zone?.tzid;
  return typeof tzid === 'string' && tzid !== 'Z' && tzid !== 'floating'
    ? tzid
    : '';
}

function recurrenceId(
  value: ICalendarTimeValue | null,
  zone: string,
): string | undefined {
  return value
    ? value.isDate
      ? value.toString()
      : instant(value, zone).toISOString()
    : undefined;
}

function recurrenceDates(
  component: ICalendarComponent,
  propertyName: string,
  zone: string,
): string[] {
  return component.getAllProperties(propertyName).flatMap((property) => {
    const values = property.getValues();
    return values
      .filter(
        (value): value is ICalendarTimeValue => value instanceof ICAL.Time,
      )
      .map(
        (value) =>
          recurrenceId(
            value,
            String(property.getFirstParameter('tzid') || zone),
          )!,
      );
  });
}

/**
 * Parse VEVENT records with their RFC 5545 source identities and recurrence
 * exception data. This does not fetch a feed or persist anything.
 */
export function parseICalendarEvents(
  source: string,
  ics: string,
  options: CalendarParseOptions = {},
): CalendarEventInput[] {
  if (!source.trim()) {
    throw new CalendarEventValidationError('Calendar source is required');
  }

  const { component } = parseICalendar(ics, options.limits);
  const seen = new Set<string>();
  return component.getAllSubcomponents('vevent').map((event) => {
    const uid = readText(event, 'uid').trim();
    if (!uid) {
      throw new CalendarEventValidationError('VEVENT UID is required');
    }

    const start = readTime(event, 'dtstart');
    const end = readTime(event, 'dtend');
    const instance = readTime(event, 'recurrence-id');
    const allDay = (start ?? instance)?.isDate === true;
    const resolvedTimeZone =
      timeZone(event, 'dtstart') ||
      timeZone(event, 'recurrence-id') ||
      options.floatingTimeZone ||
      (allDay ? 'UTC' : '');
    if ((start || instance) && !allDay && !resolvedTimeZone) {
      throw new CalendarEventValidationError(
        'Floating DTSTART requires an explicit source time-zone policy',
      );
    }
    if (resolvedTimeZone && !isValidTimeZone(resolvedTimeZone)) {
      throw new CalendarEventValidationError('Unknown IANA time zone');
    }
    const identity = {
      source,
      uid,
      recurrenceId: recurrenceId(
        instance,
        timeZone(event, 'recurrence-id') || resolvedTimeZone,
      ),
    };
    const key = JSON.stringify([uid, identity.recurrenceId ?? null]);
    if (seen.has(key))
      throw new CalendarEventValidationError('Duplicate VEVENT identity');
    seen.add(key);
    const sequence = readNumber(event, 'sequence');
    if (event.hasProperty('sequence') && (sequence === null || sequence < 0)) {
      throw new CalendarEventValidationError('Invalid SEQUENCE');
    }
    const status = readText(event, 'status').toUpperCase();
    if (status && !['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(status)) {
      throw new CalendarEventValidationError('Unsupported VEVENT STATUS');
    }
    if (!start && status !== 'CANCELLED') {
      throw new CalendarEventValidationError('VEVENT DTSTART is required');
    }
    if (
      event.hasProperty('duration') ||
      event.hasProperty('exrule') ||
      event.getFirstProperty('recurrence-id')?.getFirstParameter('range') ||
      event.getAllProperties('rdate').some((p) => p.type === 'period')
    ) {
      throw new CalendarEventValidationError(
        'Unsupported DURATION, EXRULE, RANGE or PERIOD',
      );
    }
    const startDate = start ? instant(start, resolvedTimeZone) : null;
    if (start && end && start.isDate !== end.isDate)
      throw new CalendarEventValidationError(
        'DTSTART and DTEND value types differ',
      );
    const endDate = end
      ? instant(end, timeZone(event, 'dtend') || resolvedTimeZone)
      : start && allDay
        ? instant(nextDay(start), resolvedTimeZone)
        : startDate;
    if (startDate && endDate && endDate < startDate) {
      throw new CalendarEventValidationError('DTEND precedes DTSTART');
    }

    return {
      identity,
      name: readText(event, 'summary'),
      description: readText(event, 'description'),
      startDate,
      endDate,
      detached: Boolean(instance),
      allDay,
      timeZone: resolvedTimeZone,
      status: status === 'CANCELLED' ? 'cancelled' : 'scheduled',
      sequence,
      dtstamp: readTime(event, 'dtstamp')?.toJSDate() ?? null,
      recurrence: readText(event, 'rrule') || null,
      excludedRecurrenceIds: recurrenceDates(event, 'exdate', resolvedTimeZone),
      additionalRecurrenceIds: recurrenceDates(
        event,
        'rdate',
        resolvedTimeZone,
      ),
    };
  });
}

function nextDay(value: ICalendarTimeValue): ICalendarTimeValue {
  const next = value.clone();
  next.adjust(1, 0, 0, 0);
  return next;
}

function instant(value: ICalendarTimeValue, zone: string): Date {
  if (value.zone.tzid === 'UTC' || value.zone.tzid === 'Z')
    return value.toJSDate();
  return fromZonedWallTime(
    {
      year: value.year,
      month: value.month,
      day: value.day,
      hour: value.hour,
      minute: value.minute,
      second: value.second,
      millisecond: 0,
    },
    zone || 'UTC',
  );
}

export interface CalendarExpansionOptions extends CalendarParseOptions {
  rangeStart: Date;
  rangeEnd: Date;
  /** Hard cap: exceeding it rejects the feed, never returns a partial success. */
  limit?: number;
  /** Includes occurrences scanned before the requested window. */
  maxIterations?: number;
}

/** Expand a caller-bounded window through the SDK's public recurrence engine.
 * Range endpoints are inclusive. Detached records replace their original slot;
 * EXDATE slots are returned as cancellations so previously persisted occurrences
 * are cancelled as well. No master is returned alongside its first occurrence.
 */
export function expandICalendarEvents(
  source: string,
  ics: string,
  options: CalendarExpansionOptions,
): CalendarEventInput[] {
  const { rangeStart, rangeEnd } = options;
  const limit = options.limit ?? 1000;
  const maxIterations = options.maxIterations ?? 10000;
  if (
    !Number.isFinite(rangeStart.getTime()) ||
    !Number.isFinite(rangeEnd.getTime()) ||
    rangeEnd < rangeStart ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 10000 ||
    !Number.isSafeInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > 100000
  ) {
    throw new CalendarEventValidationError('Invalid expansion bounds');
  }
  const inputs = parseICalendarEvents(source, ics, options);
  const components = parseICalendar(
    ics,
    options.limits,
  ).component.getAllSubcomponents('vevent');
  const rows = new Map<string, CalendarEventInput>();
  let iterations = 0;
  const key = (entry: CalendarEventInput) =>
    JSON.stringify([entry.identity.uid, entry.identity.recurrenceId ?? null]);
  const put = (entry: CalendarEventInput) => {
    const previous = rows.get(key(entry));
    if (!previous || entry.detached || !previous.detached)
      rows.set(key(entry), entry);
    if (rows.size > limit)
      throw new CalendarEventValidationError(
        'Calendar occurrence limit exceeded',
      );
  };
  for (let index = 0; index < inputs.length; index++) {
    const entry = inputs[index];
    if (entry.detached) continue;
    const component = components[index];
    if (!entry.recurrence && !entry.additionalRecurrenceIds.length) {
      if (
        !entry.startDate ||
        (entry.startDate >= rangeStart && entry.startDate <= rangeEnd)
      )
        put(entry);
      continue;
    }
    const start = readTime(component, 'dtstart');
    if (!start)
      throw new CalendarEventValidationError(
        'Recurring master requires DTSTART',
      );
    const rules = component.getAllProperties('rrule');
    for (const property of rules) {
      const raw = property.toJSON()[3];
      const supported = new Set([
        'freq',
        'interval',
        'count',
        'until',
        'wkst',
        'bysecond',
        'byminute',
        'byhour',
        'byday',
        'bymonthday',
        'byyearday',
        'byweekno',
        'bymonth',
        'bysetpos',
      ]);
      if (
        raw &&
        typeof raw === 'object' &&
        Object.keys(raw).some((key) => !supported.has(key))
      ) {
        throw new CalendarEventValidationError(
          'Unsupported recurrence property',
        );
      }
    }
    if (rules.length > 1)
      throw new CalendarEventValidationError('Multiple RRULEs unsupported');
    for (const property of rules) {
      const rule = property.getFirstValue();
      if (
        !(rule instanceof ICAL.Recur) ||
        !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq) ||
        rule.interval < 1 ||
        (rule.count !== null && rule.count < 1)
      ) {
        throw new CalendarEventValidationError(
          'Unsupported or malformed recurrence',
        );
      }
      if (rule instanceof ICAL.Recur) {
        const allowedParts: Record<string, string[]> = {
          DAILY: [],
          WEEKLY: ['BYDAY'],
          MONTHLY: ['BYDAY', 'BYMONTHDAY', 'BYSETPOS'],
          YEARLY: ['BYMONTH', 'BYMONTHDAY'],
        };
        if (
          Object.keys(rule.parts).some(
            (part) => !allowedParts[rule.freq]?.includes(part),
          ) ||
          (rule.freq === 'MONTHLY' &&
            ((rule.parts.BYMONTHDAY && rule.parts.BYDAY) ||
              (rule.parts.BYSETPOS && !rule.parts.BYDAY))) ||
          (rule.freq === 'WEEKLY' &&
            rule.parts.BYDAY?.some((day) => !/^[A-Z]{2}$/.test(day)))
        ) {
          throw new CalendarEventValidationError(
            'Unsupported recurrence combination',
          );
        }
      }
    }
    // EXDATE is processed as an explicit cancellation, not silently dropped.
    const expansionComponent = new ICAL.Component(
      JSON.parse(JSON.stringify(component.toJSON())),
    );
    expansionComponent.removeAllProperties('exdate');
    // RDATEs are already normalized with each property's own TZID. Do not
    // reinterpret their wall fields through the master's zone in the iterator.
    expansionComponent.removeAllProperties('rdate');
    // ICAL's floating representation has no IANA offset database. Compare an
    // UNTIL instant in the same wall zone as DTSTART, then expand wall slots.
    for (const property of expansionComponent.getAllProperties('rrule')) {
      const rule = property.getFirstValue();
      if (rule instanceof ICAL.Recur) {
        const declaredUntil = rule.until
          ? instant(rule.until, entry.timeZone)
          : rangeEnd;
        const until = declaredUntil < rangeEnd ? declaredUntil : rangeEnd;
        const wall = toZonedWallTime(until, entry.timeZone);
        rule.until = ICAL.Time.fromData(
          { ...wall, isDate: start.isDate },
          start.zone,
        );
      }
    }
    const iterator = new ICAL.RecurExpansion({
      component: expansionComponent,
      dtstart: start,
    });
    const duration =
      readTime(component, 'dtend')?.subtractDate(start) ??
      ICAL.Duration.fromSeconds(entry.allDay ? 86400 : 0);
    const emitted = new Set<string>();
    const emit = (
      occurrence: ICalendarTimeValue,
      startDate: Date,
      id: string,
    ) => {
      if (startDate < rangeStart || startDate > rangeEnd || emitted.has(id))
        return;
      emitted.add(id);
      const end = occurrence.clone();
      end.addDuration(duration);
      put({
        ...entry,
        identity: { ...entry.identity, recurrenceId: id },
        startDate,
        endDate: entry.allDay
          ? instant(end, entry.timeZone)
          : new Date(
              startDate.getTime() +
                ((entry.endDate?.getTime() ?? 0) -
                  (entry.startDate?.getTime() ?? 0)),
            ),
        detached: false,
        status: entry.excludedRecurrenceIds.includes(id)
          ? 'cancelled'
          : entry.status,
      });
    };
    for (;;) {
      if (++iterations > maxIterations)
        throw new CalendarEventValidationError(
          'Calendar iteration limit exceeded',
        );
      const occurrence = iterator.next();
      if (!occurrence) break;
      const startDate = instant(occurrence, entry.timeZone);
      if (startDate > rangeEnd) break;
      emit(occurrence, startDate, recurrenceId(occurrence, entry.timeZone)!);
    }
    for (const additional of entry.additionalRecurrenceIds) {
      if (++iterations > maxIterations)
        throw new CalendarEventValidationError(
          'Calendar iteration limit exceeded',
        );
      const occurrence = ICAL.Time.fromString(additional, undefined);
      emit(occurrence, instant(occurrence, entry.timeZone), additional);
    }
    for (const excluded of entry.excludedRecurrenceIds) {
      if (emitted.has(excluded)) continue;
      const startDate = excluded.endsWith('Z')
        ? new Date(excluded)
        : instant(ICAL.Time.fromString(excluded, undefined), entry.timeZone);
      if (startDate >= rangeStart && startDate <= rangeEnd)
        put({
          ...entry,
          identity: { ...entry.identity, recurrenceId: excluded },
          startDate,
          endDate: startDate,
          status: 'cancelled',
          detached: false,
        });
    }
  }
  for (const entry of inputs.filter((e) => e.detached)) {
    // Include an exception when its original OR moved slot is in the window.
    const originalId = entry.identity.recurrenceId!;
    const original = originalId.endsWith('Z')
      ? new Date(originalId)
      : instant(ICAL.Time.fromString(originalId, undefined), entry.timeZone);
    if (
      (original >= rangeStart && original <= rangeEnd) ||
      (entry.startDate &&
        entry.startDate >= rangeStart &&
        entry.startDate <= rangeEnd)
    )
      put(entry);
  }
  return [...rows.values()].sort(
    (a, b) => (a.startDate?.getTime() ?? 0) - (b.startDate?.getTime() ?? 0),
  );
}
