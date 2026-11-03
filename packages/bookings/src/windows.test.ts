import { describe, expect, it } from 'vitest';
import {
  declareWindows,
  elapsedHour,
  fitsCapacity,
  resolveBookingWindow,
} from './windows.js';

describe('booking wall time', () => {
  const zone = 'America/New_York';

  it('requires a valid offset and refuses a spring DST gap or a normalized invalid date', () => {
    for (const start of [
      '2027-03-14T02:15-05:00',
      '2027-03-14T02:15-04:00',
      '2027-03-14T01:15',
      '2027-02-29T01:15-05:00',
      '2027-03-14T01:15-04:00',
    ]) {
      expect(() =>
        resolveBookingWindow({ zone, start, end: '2027-03-14T04:00-04:00' }),
      ).toThrow();
    }
    expect(() =>
      resolveBookingWindow({
        zone: '-05:00',
        start: '2027-03-14T01:00-05:00',
        end: '2027-03-14T02:00-05:00',
      }),
    ).toThrow();
  });

  it('distinguishes both sides of a DST fold as one elapsed hour', () => {
    const window = resolveBookingWindow({
      zone,
      start: '2027-11-07T01:30-04:00',
      end: '2027-11-07T01:30-05:00',
    });
    expect(window).toMatchObject({
      startUtc: '2027-11-07T05:30:00.000Z',
      endUtc: '2027-11-07T06:30:00.000Z',
    });
    expect(elapsedHour(window)).toBe(true);
  });

  it('treats a supervision day as a local calendar window across DST', () => {
    const first = {
      start: '2027-03-14T00:00-05:00',
      end: '2027-03-15T00:00-04:00',
      capacity: 3,
      supervision: true,
    };
    const [window] = declareWindows(zone, [first]);
    expect(Date.parse(window.endUtc) - Date.parse(window.startUtc)).toBe(
      23 * 3_600_000,
    );
    expect(() =>
      declareWindows(zone, [{ ...first, end: '2027-03-15T01:00-04:00' }]),
    ).toThrow();
    expect(() =>
      declareWindows(zone, [
        { ...first, end: '2027-03-14T01:00-05:00' },
        { ...first, start: '2027-03-14T03:00-04:00' },
      ]),
    ).toThrow();
  });
});

describe('capacity by half-open segment', () => {
  const time = (hour: string) => `2027-01-01T${hour}+00:00`;
  const availability = declareWindows('UTC', [
    {
      start: time('09:00'),
      end: time('11:00'),
      capacity: 2,
      supervision: false,
    },
    {
      start: time('08:00'),
      end: time('09:00'),
      capacity: 1,
      supervision: false,
    },
  ]);
  const reservation = (start: string, end: string, exclusive = false) => ({
    ...resolveBookingWindow({
      zone: 'UTC',
      start: time(start),
      end: time(end),
    }),
    exclusive,
  });

  it('checks the capacity and overlap on each segment, with endings before beginnings', () => {
    expect(
      fitsCapacity(reservation('08:00', '10:00'), availability, [
        reservation('09:00', '10:00'),
      ]),
    ).toBe(true);
    expect(
      fitsCapacity(reservation('08:00', '10:00'), availability, [
        reservation('08:00', '09:00'),
      ]),
    ).toBe(false);
    expect(
      fitsCapacity(reservation('08:00', '10:00'), availability, [
        reservation('10:00', '11:00', true),
      ]),
    ).toBe(true);
    expect(
      fitsCapacity(reservation('08:00', '10:00', true), availability, [
        reservation('09:00', '10:00'),
      ]),
    ).toBe(false);
    expect(fitsCapacity(reservation('07:00', '09:00'), availability, [])).toBe(
      false,
    );
  });
});
