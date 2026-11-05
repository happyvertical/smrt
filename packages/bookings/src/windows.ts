import { BookingError } from './errors.js';
import type {
  AvailabilityWindow,
  BookingUnit,
  BookingWindow,
  DeclaredAvailabilityWindow,
  ResolvedBookingWindow,
} from './types.js';

const WALL = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})([+-]\d{2}:\d{2})$/;
const MINUTE_MS = 60_000;

function formatter(zone: string): Intl.DateTimeFormat {
  // Intl also accepts offsets as time zone names. These are not IANA zones.
  if (typeof zone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(zone)) {
    throw new BookingError('invalid', 'An IANA time zone is required');
  }
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new BookingError('invalid', 'Unknown IANA time zone');
  }
}

function instant(value: string, format: Intl.DateTimeFormat): string {
  const match = typeof value === 'string' ? WALL.exec(value) : null;
  if (!match || match[2] === '-00:00') {
    throw new BookingError(
      'invalid',
      'Expected local minute with explicit UTC offset',
    );
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new BookingError('invalid', 'Invalid local timestamp');
  }
  const parts = Object.fromEntries(
    format.formatToParts(time).map(({ type, value }) => [type, value]),
  );
  const local = `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  if (local !== match[1] || parts.second !== '00') {
    throw new BookingError(
      'invalid',
      'Local timestamp and offset do not exist in this zone',
    );
  }
  return new Date(time).toISOString();
}

/** Resolve half-open wall time; a DST fold must name the intended offset. */
export function resolveBookingWindow(
  window: BookingWindow,
): ResolvedBookingWindow {
  const format = formatter(window.zone);
  const startUtc = instant(window.start, format);
  const endUtc = instant(window.end, format);
  if (startUtc >= endUtc) {
    throw new BookingError(
      'invalid',
      'A booking window must have positive duration',
    );
  }
  return {
    zone: format.resolvedOptions().timeZone,
    start: window.start,
    end: window.end,
    startUtc,
    endUtc,
  };
}

export function elapsedHour(window: ResolvedBookingWindow): boolean {
  return (
    Date.parse(window.endUtc) - Date.parse(window.startUtc) === 60 * MINUTE_MS
  );
}

function oneLocalDay(window: ResolvedBookingWindow): boolean {
  const startDate = window.start.slice(0, 10);
  const endDate = window.end.slice(0, 10);
  if (startDate === endDate) return true;
  if (!window.end.slice(10).startsWith('T00:00')) return false;
  const tomorrow = new Date(`${startDate}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return tomorrow.toISOString().slice(0, 10) === endDate;
}

export function declareWindows(
  zone: string,
  windows: readonly AvailabilityWindow[],
): DeclaredAvailabilityWindow[] {
  formatter(zone);
  if (!Array.isArray(windows))
    throw new BookingError('invalid', 'Expected availability windows');
  const days = new Set<string>();
  const normalized = windows
    .map(({ start, end, capacity, supervision }) => {
      if (
        !Number.isSafeInteger(capacity) ||
        capacity < 1 ||
        typeof supervision !== 'boolean'
      ) {
        throw new BookingError(
          'invalid',
          'Availability requires positive integer capacity and a supervision flag',
        );
      }
      const window = resolveBookingWindow({ start, end, zone });
      const day = start.slice(0, 10);
      if (supervision) {
        if (!oneLocalDay(window) || days.has(day)) {
          throw new BookingError(
            'invalid',
            'Declare at most one supervision window per local day',
          );
        }
        days.add(day);
      }
      return { ...window, capacity, supervision };
    })
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  if (
    normalized.some(
      (window, i) => i > 0 && normalized[i - 1].endUtc > window.startUtc,
    )
  ) {
    throw new BookingError('invalid', 'Availability windows must not overlap');
  }
  return normalized;
}

export interface Reservation {
  startUtc: string;
  endUtc: string;
  exclusive: boolean;
}

export function supervisionDeclared(
  candidate: ResolvedBookingWindow,
  windows: readonly DeclaredAvailabilityWindow[],
): boolean {
  return windows.some(
    (window) =>
      window.supervision &&
      candidate.start === window.start &&
      candidate.end === window.end &&
      candidate.zone === window.zone,
  );
}

/**
 * Remaining units for the candidate: 0 when it does not fit, 1 for an exclusive
 * candidate that fits, and for a shared candidate the minimum of
 * (capacity - shared) across every half-open segment. Endpoints belonging to
 * ending windows are excluded.
 */
export function remainingCapacity(
  candidate: Reservation,
  declared: readonly DeclaredAvailabilityWindow[],
  occupied: readonly Reservation[],
): number {
  type Delta = { capacity: number; shared: number; exclusive: number };
  const boundaries = new Map<string, Delta>();
  const add = (at: string, key: keyof Delta, delta: number) => {
    const event = boundaries.get(at) ?? {
      capacity: 0,
      shared: 0,
      exclusive: 0,
    };
    event[key] += delta;
    boundaries.set(at, event);
  };
  const sweep = (
    window: Reservation | DeclaredAvailabilityWindow,
    key: keyof Delta,
    units: number,
  ) => {
    if (
      window.startUtc >= candidate.endUtc ||
      window.endUtc <= candidate.startUtc
    )
      return;
    add(
      window.startUtc < candidate.startUtc
        ? candidate.startUtc
        : window.startUtc,
      key,
      units,
    );
    if (window.endUtc < candidate.endUtc) add(window.endUtc, key, -units);
  };

  // Seed the first segment even when there is no declared coverage there.
  add(candidate.startUtc, 'capacity', 0);
  for (const window of declared) sweep(window, 'capacity', window.capacity);
  for (const reservation of occupied)
    sweep(reservation, reservation.exclusive ? 'exclusive' : 'shared', 1);

  let capacity = 0;
  let shared = 0;
  let exclusive = 0;
  let remaining = Number.POSITIVE_INFINITY;
  for (const at of [...boundaries.keys()].sort()) {
    const delta = boundaries.get(at);
    if (!delta) continue;
    // Apply ends and starts together before checking the segment beginning here.
    capacity += delta.capacity;
    shared += delta.shared;
    exclusive += delta.exclusive;
    if (
      capacity < 1 ||
      exclusive > 0 ||
      (candidate.exclusive ? shared > 0 : shared >= capacity)
    )
      return 0;
    remaining = Math.min(
      remaining,
      candidate.exclusive ? 1 : capacity - shared,
    );
  }
  return Number.isFinite(remaining) ? remaining : 0;
}

export function fitsCapacity(
  candidate: Reservation,
  declared: readonly DeclaredAvailabilityWindow[],
  occupied: readonly Reservation[],
): boolean {
  return remainingCapacity(candidate, declared, occupied) >= 1;
}

/** Most segments one proposal may reserve; discovery never lists a larger bundle. */
export const MAX_SEGMENTS = 400;

/** Resolve one or more same-zone segments into sorted, non-overlapping windows and their span. */
export function resolveCoverage(windows: readonly BookingWindow[]): {
  windows: ResolvedBookingWindow[];
  span: ResolvedBookingWindow;
} {
  if (
    !Array.isArray(windows) ||
    windows.length < 1 ||
    windows.length > MAX_SEGMENTS
  ) {
    throw new BookingError(
      'invalid',
      `Expected between 1 and ${MAX_SEGMENTS} booking windows`,
    );
  }
  const resolved = windows
    .map((window) => resolveBookingWindow(window))
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  for (const [i, window] of resolved.entries()) {
    if (window.zone !== resolved[0].zone) {
      throw new BookingError('invalid', 'Booking windows must share one zone');
    }
    if (i > 0 && resolved[i - 1].endUtc > window.startUtc) {
      throw new BookingError('invalid', 'Booking windows must not overlap');
    }
  }
  const first = resolved[0];
  const last = resolved[resolved.length - 1];
  return {
    windows: resolved,
    span: {
      zone: first.zone,
      start: first.start,
      end: last.end,
      startUtc: first.startUtc,
      endUtc: last.endUtc,
    },
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Add n local days to YYYY-MM-DD with date-only arithmetic. */
export function addLocalDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** Add n calendar months, constraining the day to the target month's length. */
export function addLocalMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = index % 12;
  const length = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  return `${pad(targetYear, 4)}-${pad(targetMonth + 1)}-${pad(Math.min(day, length))}`;
}

/** Exclusive local end date of a quantity of the unit starting on a local date. */
export function localEnd(
  unit: BookingUnit,
  quantity: number,
  start: string,
): string {
  if (unit === 'day') return addLocalDays(start, quantity);
  if (unit === 'week') return addLocalDays(start, 7 * quantity);
  return addLocalMonths(start, quantity);
}

function within(window: ResolvedBookingWindow, from: string, to: string) {
  return (
    window.start.slice(0, 10) >= from &&
    (window.end.slice(0, 10) < to || window.end.slice(0, 16) === `${to}T00:00`)
  );
}

/** True iff the segments measure exactly `quantity` of `unit`. */
export function measures(
  unit: BookingUnit,
  quantity: number,
  windows: readonly ResolvedBookingWindow[],
): boolean {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || windows.length < 1) {
    return false;
  }
  if (unit === 'hour') {
    const total = windows.reduce(
      (sum, w) => sum + (Date.parse(w.endUtc) - Date.parse(w.startUtc)),
      0,
    );
    return total === quantity * 60 * MINUTE_MS;
  }
  if (unit !== 'day' && unit !== 'week' && unit !== 'month') return false;
  const from = windows[0].start.slice(0, 10);
  const to = localEnd(unit, quantity, from);
  if (!windows.every((window) => within(window, from, to))) return false;
  // A day offering is sold per local calendar day: the segments must touch
  // exactly `quantity` distinct days, so one day of coverage cannot bill for two.
  if (unit === 'day') {
    const days = new Set<string>();
    for (const window of windows) {
      const last =
        window.end.slice(0, 16) === `${window.end.slice(0, 10)}T00:00` &&
        window.end.slice(0, 10) > window.start.slice(0, 10)
          ? addLocalDays(window.end.slice(0, 10), -1)
          : window.end.slice(0, 10);
      for (
        let day = window.start.slice(0, 10);
        day <= last;
        day = addLocalDays(day, 1)
      ) {
        days.add(day);
      }
    }
    return days.size === quantity;
  }
  return true;
}

/** Do these segments fall in the half-open local span of a quantity of unit from a date? */
export function withinLocalSpan(
  window: ResolvedBookingWindow,
  unit: Exclude<BookingUnit, 'hour'>,
  quantity: number,
  from: string,
): boolean {
  return within(window, from, localEnd(unit, quantity, from));
}

/** Render a UTC instant as a minute-precision local timestamp with its zone offset. */
export function formatWall(instantIso: string, zone: string): string {
  const time = Date.parse(instantIso);
  if (!Number.isFinite(time)) {
    throw new BookingError('invalid', 'Invalid instant');
  }
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(time)
      .map(({ type, value }) => [type, value]),
  );
  const local = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offset = Math.round((local - time) / MINUTE_MS);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${pad(Number(parts.year), 4)}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Build a resolved window from two UTC instants, rendered in the zone. */
export function windowFromInstants(
  zone: string,
  startMs: number,
  endMs: number,
): ResolvedBookingWindow {
  return resolveBookingWindow({
    zone,
    start: formatWall(new Date(startMs).toISOString(), zone),
    end: formatWall(new Date(endMs).toISOString(), zone),
  });
}
