import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNextCronDate } from './schedule.js';

/**
 * Regression for the deep-review #1397 major finding (T2): the cron parser
 * AND-ed day-of-month and day-of-week. POSIX cron ORs them when BOTH are
 * restricted (non-`*`), so `0 0 13 * 5` must fire on the 13th OR any Friday —
 * not only on Friday-the-13th. When only one of the two is restricted, that
 * field alone applies (AND semantics with the rest).
 *
 * `getNextCronDate` reads the host's local clock, so these tests pin time with
 * fake timers to keep the assertions deterministic.
 */
describe('getNextCronDate — DOM/DOW OR semantics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ORs day-of-month and day-of-week when both are restricted', () => {
    // Pin "now" to Mon 2026-06-01 00:00 local. The next Friday is 2026-06-05;
    // the next 13th is 2026-06-13. With OR semantics the earlier (Friday the
    // 5th) wins. The buggy AND impl would skip both and wait for the next
    // Friday-the-13th (2026-11-13), months away.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 0, 0, 0, 0));

    const next = getNextCronDate('0 0 13 * 5');

    // Earliest match is Friday 2026-06-05 at 00:00.
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(5); // June (0-indexed)
    expect(next.getDate()).toBe(5);
    expect(next.getDay()).toBe(5); // Friday
    // It must be a same-month hit, never deferred to Friday-the-13th.
    expect(next.getTime()).toBeLessThan(new Date(2026, 5, 13).getTime());
  });

  it('matches the day-of-month even when it is not the restricted weekday', () => {
    // Pin "now" to Sat 2026-09-12 23:00. The next 13th (Sun 2026-09-13 00:00)
    // is NOT a Friday and arrives before the next Friday (2026-09-18). OR
    // semantics must fire on the 13th — proving the day-of-month triggers
    // independently of the restricted weekday.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 12, 23, 0, 0, 0));

    const next = getNextCronDate('0 0 13 * 5');

    expect(next.getMonth()).toBe(8); // September (0-indexed)
    expect(next.getDate()).toBe(13);
    expect(next.getDay()).toBe(0); // 2026-09-13 is a Sunday, not Friday
  });

  it('fires on the next Friday when only day-of-week is restricted', () => {
    // `0 0 * * 5` — DOM is wildcard, so only DOW applies. From Mon 2026-06-01
    // the next Friday is 2026-06-05.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 0, 0, 0, 0));

    const next = getNextCronDate('0 0 * * 5');

    expect(next.getDate()).toBe(5);
    expect(next.getDay()).toBe(5);
  });

  it('fires on the next 13th when only day-of-month is restricted', () => {
    // `0 0 13 * *` — DOW is wildcard, so only DOM applies. From 2026-06-01 the
    // next 13th is 2026-06-13 regardless of weekday.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 0, 0, 0, 0));

    const next = getNextCronDate('0 0 13 * *');

    expect(next.getDate()).toBe(13);
    expect(next.getMonth()).toBe(5);
  });

  it('treats day-of-week 0 and 7 as Sunday', () => {
    // From Mon 2026-06-01 the next Sunday is 2026-06-07. Both `0` and `7`
    // must select it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 0, 0, 0, 0));

    const viaZero = getNextCronDate('0 0 * * 0');
    const viaSeven = getNextCronDate('0 0 * * 7');

    expect(viaZero.getDay()).toBe(0); // Sunday
    expect(viaZero.getDate()).toBe(7);
    expect(viaSeven.getTime()).toBe(viaZero.getTime());
  });
});

describe('getNextCronDate — basic field matching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 12, 30, 0, 0)); // Mon 2026-06-01 12:30
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('advances to the next matching minute for a daily time', () => {
    // `0 2 * * *` — 02:00 daily. From 12:30 the next hit is tomorrow 02:00.
    const next = getNextCronDate('0 2 * * *');
    expect(next.getHours()).toBe(2);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(2); // next day
  });

  it('honors step expressions', () => {
    // `*/15 * * * *` — every 15 minutes. From 12:30 the next is 12:45.
    const next = getNextCronDate('*/15 * * * *');
    expect(next.getMinutes()).toBe(45);
    expect(next.getHours()).toBe(12);
  });

  it('throws on the wrong field count', () => {
    expect(() => getNextCronDate('* * * *')).toThrow(/expected 5 fields/);
  });
});
