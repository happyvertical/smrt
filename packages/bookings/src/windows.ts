import { BookingError } from './errors.js';
import type {
  AvailabilityWindow,
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

/** Check every segment; endpoints belonging to ending windows are excluded. */
export function fitsCapacity(
  candidate: Reservation,
  declared: readonly DeclaredAvailabilityWindow[],
  occupied: readonly Reservation[],
): boolean {
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
      return false;
  }
  return true;
}
