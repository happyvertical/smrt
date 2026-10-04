import {
  ICAL,
  type ICalendarComponent,
  type ICalendarParseLimits,
  parseICalendar,
} from '@happyvertical/icalendar';

/** A stable upstream identity for a calendar master or detached occurrence. */
export interface CalendarEventIdentity {
  source: string;
  uid: string;
  recurrenceId?: string;
}

/** Parsed data SMRT needs before applying its persistence policy. */
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

function recurrenceId(value: ICalendarTimeValue | null): string | undefined {
  return value ? value.toString() : undefined;
}

function recurrenceDates(
  component: ICalendarComponent,
  propertyName: string,
): string[] {
  return component.getAllProperties(propertyName).flatMap((property) => {
    const values = property.getValues();
    return values
      .filter(
        (value): value is ICalendarTimeValue => value instanceof ICAL.Time,
      )
      .map((value) => value.toString());
  });
}

/**
 * Parse VEVENT records with their RFC 5545 source identities and recurrence
 * exception data. This does not fetch a feed or persist anything.
 */
export function parseICalendarEvents(
  source: string,
  ics: string,
  limits?: ICalendarParseLimits,
): CalendarEventInput[] {
  if (!source.trim()) {
    throw new CalendarEventValidationError('Calendar source is required');
  }

  const { component } = parseICalendar(ics, limits);
  return component.getAllSubcomponents('vevent').map((event) => {
    const uid = readText(event, 'uid').trim();
    if (!uid) {
      throw new CalendarEventValidationError('VEVENT UID is required');
    }

    const start = readTime(event, 'dtstart');
    const end = readTime(event, 'dtend');
    const instance = readTime(event, 'recurrence-id');
    const allDay = start?.isDate === true;
    const resolvedTimeZone =
      timeZone(event, 'dtstart') || timeZone(event, 'recurrence-id');
    if (start && !resolvedTimeZone) {
      throw new CalendarEventValidationError(
        'Floating DTSTART requires an explicit source time-zone policy',
      );
    }
    const status = readText(event, 'status').toUpperCase();

    return {
      identity: { source, uid, recurrenceId: recurrenceId(instance) },
      name: readText(event, 'summary'),
      description: readText(event, 'description'),
      startDate: start?.toJSDate() ?? null,
      endDate: end?.toJSDate() ?? null,
      allDay,
      timeZone: resolvedTimeZone,
      status: status === 'CANCELLED' ? 'cancelled' : 'scheduled',
      sequence: readNumber(event, 'sequence'),
      dtstamp: readTime(event, 'dtstamp')?.toJSDate() ?? null,
      recurrence: readText(event, 'rrule') || null,
      excludedRecurrenceIds: recurrenceDates(event, 'exdate'),
      additionalRecurrenceIds: recurrenceDates(event, 'rdate'),
    };
  });
}
