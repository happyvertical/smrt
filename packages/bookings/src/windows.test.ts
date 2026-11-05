import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  addLocalMonths,
  declareWindows,
  elapsedHour,
  fitsCapacity,
  formatWall,
  measures,
  remainingCapacity,
  resolveBookingWindow,
  resolveCoverage,
  windowFromInstants,
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

describe('local date arithmetic', () => {
  it('adds days and constrains month ends', () => {
    expect(addLocalDays('2027-02-27', 3)).toBe('2027-03-02');
    expect(addLocalDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(addLocalMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addLocalMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addLocalMonths('2027-01-31', 12)).toBe('2028-01-31');
    expect(addLocalMonths('2027-11-15', 3)).toBe('2028-02-15');
  });
});

describe('coverage and measurement', () => {
  const ny = 'America/New_York';
  const win = (zone: string, start: string, end: string) =>
    resolveBookingWindow({ zone, start, end });
  const utc = (start: string, end: string) =>
    win('UTC', `2027-01-01T${start}+00:00`, `2027-01-01T${end}+00:00`);

  it('resolves sorted non-overlapping coverage and its span', () => {
    const { windows, span } = resolveCoverage([
      {
        zone: 'UTC',
        start: '2027-01-02T09:00+00:00',
        end: '2027-01-02T12:00+00:00',
      },
      {
        zone: 'UTC',
        start: '2027-01-01T09:00+00:00',
        end: '2027-01-01T12:00+00:00',
      },
    ]);
    expect(windows.map((w) => w.start)).toEqual([
      '2027-01-01T09:00+00:00',
      '2027-01-02T09:00+00:00',
    ]);
    expect(span).toMatchObject({
      start: '2027-01-01T09:00+00:00',
      end: '2027-01-02T12:00+00:00',
      startUtc: '2027-01-01T09:00:00.000Z',
      endUtc: '2027-01-02T12:00:00.000Z',
    });
    expect(() => resolveCoverage([])).toThrow();
    expect(() =>
      resolveCoverage([
        {
          zone: 'UTC',
          start: '2027-01-01T09:00+00:00',
          end: '2027-01-01T11:00+00:00',
        },
        {
          zone: 'UTC',
          start: '2027-01-01T10:00+00:00',
          end: '2027-01-01T12:00+00:00',
        },
      ]),
    ).toThrow();
    expect(() =>
      resolveCoverage([
        {
          zone: 'UTC',
          start: '2027-01-01T09:00+00:00',
          end: '2027-01-01T10:00+00:00',
        },
        {
          zone: ny,
          start: '2027-01-01T08:00-05:00',
          end: '2027-01-01T09:00-05:00',
        },
      ]),
    ).toThrow();
  });

  it('measures hours by elapsed UTC time across split segments and a DST fold', () => {
    expect(
      measures('hour', 1, [utc('09:00', '09:30'), utc('10:00', '10:30')]),
    ).toBe(true);
    expect(measures('hour', 1, [utc('09:00', '09:59')])).toBe(false);
    expect(measures('hour', 2, [utc('09:00', '10:00')])).toBe(false);
    expect(
      measures('hour', 1, [
        win(ny, '2027-11-07T01:30-04:00', '2027-11-07T01:30-05:00'),
      ]),
    ).toBe(true);
  });

  it('measures day, week and month as half-open local spans', () => {
    const day = (d: string, a = '09:00', b = '17:00') =>
      win(ny, `${d}T${a}-05:00`, `${d}T${b}-05:00`);
    expect(
      measures('day', 1, [
        day('2027-01-04', '09:00', '12:00'),
        day('2027-01-04', '13:00', '17:00'),
      ]),
    ).toBe(true);
    expect(measures('day', 2, [day('2027-01-04'), day('2027-01-05')])).toBe(
      true,
    );
    expect(measures('day', 1, [day('2027-01-04'), day('2027-01-05')])).toBe(
      false,
    );
    // One day of coverage cannot satisfy two days.
    expect(measures('day', 2, [day('2027-01-04')])).toBe(false);
    expect(measures('day', 2, [day('2027-01-04'), day('2027-01-06')])).toBe(
      false,
    );
    expect(
      measures('day', 1, [
        win(ny, '2027-01-04T09:00-05:00', '2027-01-05T00:00-05:00'),
      ]),
    ).toBe(true);
    expect(
      measures('day', 1, [
        win(ny, '2027-01-04T09:00-05:00', '2027-01-05T00:01-05:00'),
      ]),
    ).toBe(false);
    expect(measures('week', 1, [day('2027-01-04'), day('2027-01-10')])).toBe(
      true,
    );
    expect(measures('week', 1, [day('2027-01-04'), day('2027-01-11')])).toBe(
      false,
    );
    expect(measures('month', 1, [day('2027-01-31'), day('2027-02-27')])).toBe(
      true,
    );
    expect(measures('month', 1, [day('2027-01-31'), day('2027-02-28')])).toBe(
      false,
    );
    // A window crossing the spring-forward day still fits its local date.
    expect(
      measures('day', 1, [
        win(ny, '2027-03-14T00:00-05:00', '2027-03-15T00:00-04:00'),
      ]),
    ).toBe(true);
    expect(measures('day', 0, [day('2027-01-04')])).toBe(false);
  });

  it('round-trips wall formatting through window resolution', () => {
    expect(formatWall('2027-11-07T05:30:00.000Z', ny)).toBe(
      '2027-11-07T01:30-04:00',
    );
    expect(formatWall('2027-11-07T06:30:00.000Z', ny)).toBe(
      '2027-11-07T01:30-05:00',
    );
    expect(formatWall('2027-03-14T06:59:00.000Z', ny)).toBe(
      '2027-03-14T01:59-05:00',
    );
    expect(formatWall('2027-03-14T07:00:00.000Z', ny)).toBe(
      '2027-03-14T03:00-04:00',
    );
    const fold = windowFromInstants(
      ny,
      Date.parse('2027-11-07T05:30:00Z'),
      Date.parse('2027-11-07T06:30:00Z'),
    );
    expect(fold).toMatchObject({
      start: '2027-11-07T01:30-04:00',
      end: '2027-11-07T01:30-05:00',
    });
    const gap = windowFromInstants(
      ny,
      Date.parse('2027-03-14T06:00:00Z'),
      Date.parse('2027-03-14T08:00:00Z'),
    );
    expect(gap).toMatchObject({
      start: '2027-03-14T01:00-05:00',
      end: '2027-03-14T04:00-04:00',
    });
  });

  it('reports remaining capacity for exclusive and shared candidates', () => {
    const availability = declareWindows('UTC', [
      {
        start: '2027-01-01T09:00+00:00',
        end: '2027-01-01T10:00+00:00',
        capacity: 3,
        supervision: false,
      },
      {
        start: '2027-01-01T10:00+00:00',
        end: '2027-01-01T11:00+00:00',
        capacity: 2,
        supervision: false,
      },
    ]);
    const hold = (a: string, b: string, exclusive = false) => ({
      ...utc(a, b),
      exclusive,
    });
    expect(
      remainingCapacity(hold('09:00', '11:00', true), availability, []),
    ).toBe(1);
    expect(remainingCapacity(hold('09:00', '11:00'), availability, [])).toBe(2);
    expect(
      remainingCapacity(hold('09:00', '11:00'), availability, [
        hold('10:00', '11:00'),
      ]),
    ).toBe(1);
    expect(
      remainingCapacity(hold('09:00', '11:00'), availability, [
        hold('09:30', '10:30', true),
      ]),
    ).toBe(0);
    expect(remainingCapacity(hold('09:00', '12:00'), availability, [])).toBe(0);
  });
});
