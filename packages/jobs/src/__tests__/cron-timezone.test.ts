import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNextCronDate } from '../schedule-runner.js';

/**
 * #3859: cron fields are evaluated in the schedule's IANA zone, not the
 * process zone. Every assertion is an absolute instant, and the whole suite
 * runs once per host zone below (Node re-reads `process.env.TZ` on
 * assignment), proving the result does not depend on the process `TZ`.
 *
 * America/Edmonton 2025: spring forward Sun 2025-03-09 02:00 MST → 03:00 MDT
 * (09:00Z); fall back Sun 2025-11-02 02:00 MDT → 01:00 MST (08:00Z). The
 * transitions are deliberately historical: tzdata only revises future rules
 * (2026c already ends Edmonton's DST cycle), so past dates keep the suite
 * stable across Node/ICU updates.
 */
const EDMONTON = 'America/Edmonton';

function nextAt(nowIso: string, cron: string, timezone?: string): string {
  vi.setSystemTime(new Date(nowIso));
  return getNextCronDate(cron, timezone).toISOString();
}

const HOST_ZONES = [
  'UTC',
  'America/Edmonton',
  'Asia/Kolkata',
  'Pacific/Auckland',
];

describe.each(
  HOST_ZONES,
)('getNextCronDate — schedule time zone (#3859), host TZ=%s', (hostZone) => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = hostZone;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('runs with the host zone applied', () => {
    // Guard: the host-zone loop is only meaningful if Node honours it.
    const offset = new Date('2025-06-01T00:00:00Z').getTimezoneOffset();
    expect(offset).toBe(
      {
        UTC: 0,
        'America/Edmonton': 360,
        'Asia/Kolkata': -330,
        'Pacific/Auckland': -720,
      }[hostZone],
    );
  });

  it('evaluates the cron in the given zone, not the process zone', () => {
    vi.useFakeTimers();
    // Issue repro: 03:05 Edmonton (MDT, UTC-6) is 09:05Z, not 03:05Z.
    expect(nextAt('2025-06-01T00:00:00Z', '5 3 * * *', EDMONTON)).toBe(
      '2025-06-01T09:05:00.000Z',
    );
    expect(nextAt('2025-06-01T00:00:00Z', '5 3 * * *', 'UTC')).toBe(
      '2025-06-01T03:05:00.000Z',
    );
    // Half-hour zone: 09:00 IST (UTC+5:30) is 03:30Z.
    expect(nextAt('2025-06-01T00:00:00Z', '0 9 * * *', 'Asia/Kolkata')).toBe(
      '2025-06-01T03:30:00.000Z',
    );
  });

  it('follows the zone across the spring-forward boundary', () => {
    vi.useFakeTimers();
    // Sat 03:05 MST (UTC-7) …
    expect(nextAt('2025-03-08T00:00:00Z', '5 3 * * *', EDMONTON)).toBe(
      '2025-03-08T10:05:00.000Z',
    );
    // … then Sun 03:05 MDT (UTC-6): one hour earlier in UTC.
    expect(nextAt('2025-03-08T10:06:00Z', '5 3 * * *', EDMONTON)).toBe(
      '2025-03-09T09:05:00.000Z',
    );
  });

  it('follows the zone across the fall-back boundary', () => {
    vi.useFakeTimers();
    expect(nextAt('2025-11-01T00:00:00Z', '5 3 * * *', EDMONTON)).toBe(
      '2025-11-01T09:05:00.000Z',
    );
    expect(nextAt('2025-11-01T09:06:00Z', '5 3 * * *', EDMONTON)).toBe(
      '2025-11-02T10:05:00.000Z',
    );
  });

  it('shifts a fixed time skipped by spring-forward past the gap', () => {
    vi.useFakeTimers();
    // 02:30 does not exist on 2025-03-09; it runs at 03:30 MDT (09:30Z),
    // including when "now" is already past the gap but before 03:30.
    expect(nextAt('2025-03-09T00:00:00Z', '30 2 * * *', EDMONTON)).toBe(
      '2025-03-09T09:30:00.000Z',
    );
    expect(nextAt('2025-03-09T09:10:00Z', '30 2 * * *', EDMONTON)).toBe(
      '2025-03-09T09:30:00.000Z',
    );
    // The next day is back to the normal wall time (02:30 MDT = 08:30Z).
    expect(nextAt('2025-03-09T09:31:00Z', '30 2 * * *', EDMONTON)).toBe(
      '2025-03-10T08:30:00.000Z',
    );
  });

  it('skips wildcard wall times inside the spring-forward gap', () => {
    vi.useFakeTimers();
    // From 01:40 MST, `30 * * * *` next fires at 03:30 MDT: 02:30 never
    // happens and elapsed time is exactly one hour (08:30Z → 09:30Z).
    expect(nextAt('2025-03-09T08:40:00Z', '30 * * * *', EDMONTON)).toBe(
      '2025-03-09T09:30:00.000Z',
    );
  });

  it('runs a fixed time in the repeated fall-back hour only once', () => {
    vi.useFakeTimers();
    // First 01:30 is MDT (07:30Z) …
    expect(nextAt('2025-11-02T06:00:00Z', '30 1 * * *', EDMONTON)).toBe(
      '2025-11-02T07:30:00.000Z',
    );
    // … and the repeated 01:30 MST (08:30Z) is not a second run.
    expect(nextAt('2025-11-02T07:31:00Z', '30 1 * * *', EDMONTON)).toBe(
      '2025-11-03T08:30:00.000Z',
    );
  });

  it('keeps wildcard schedules running through the repeated hour', () => {
    vi.useFakeTimers();
    // 01:45 MDT: the next `*/20` slot is the repeated 01:00 (MST, 08:00Z),
    // not 02:00 MST an hour later.
    expect(nextAt('2025-11-02T07:45:00Z', '*/20 * * * *', EDMONTON)).toBe(
      '2025-11-02T08:00:00.000Z',
    );
    expect(nextAt('2025-11-02T08:05:00Z', '*/20 * * * *', EDMONTON)).toBe(
      '2025-11-02T08:20:00.000Z',
    );
    expect(nextAt('2025-11-02T08:41:00Z', '*/20 * * * *', EDMONTON)).toBe(
      '2025-11-02T09:00:00.000Z',
    );
  });

  it('matches day-of-week and day-of-month on the zone date', () => {
    vi.useFakeTimers();
    // 2025-06-06T03:00Z is still Thursday 06-05 21:00 in Edmonton; the next
    // Friday 00:00 there is 2025-06-06T06:00Z.
    expect(nextAt('2025-06-06T03:00:00Z', '0 0 * * 5', EDMONTON)).toBe(
      '2025-06-06T06:00:00.000Z',
    );
    // Same instant in Auckland (UTC+12) is already Friday 15:00; the next
    // 1st-of-month midnight there is 2025-06-30T12:00Z.
    expect(
      nextAt('2025-06-06T03:00:00Z', '0 0 1 * *', 'Pacific/Auckland'),
    ).toBe('2025-06-30T12:00:00.000Z');
  });

  it('rejects an unrecognized time zone', () => {
    expect(() => getNextCronDate('0 0 * * *', 'Mars/Olympus_Mons')).toThrow(
      /Invalid cron timezone: "Mars\/Olympus_Mons"/,
    );
    expect(() => getNextCronDate('0 0 * * *', '')).toThrow(
      /Invalid cron timezone/,
    );
  });

  it('uses the host zone only when no zone is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T00:00:00Z'));
    const local = getNextCronDate('5 3 * * *');
    expect(local.getHours()).toBe(3);
    expect(local.getMinutes()).toBe(5);
    expect(getNextCronDate('5 3 * * *', null).getTime()).toBe(local.getTime());
  });
});
