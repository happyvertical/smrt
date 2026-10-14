import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNextCronDate } from '../schedule-runner.js';

/**
 * Regression for the deep-review #1397 major finding (T2): the agents cron
 * parser AND-ed day-of-month and day-of-week. The smrt-jobs ScheduleRunner is
 * the authoritative cron parser and already implements the correct POSIX OR
 * semantics — when BOTH DOM and DOW are restricted (non-`*`) a date matches if
 * EITHER does. This test locks that behavior so the twin parser can't regress
 * back to AND.
 *
 * `getNextCronDate` reads the host's local clock, so time is pinned with fake
 * timers to keep assertions deterministic.
 */
describe('ScheduleRunner getNextCronDate — DOM/DOW OR semantics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ORs day-of-month and day-of-week when both are restricted', () => {
    // From Mon 2026-06-01 the next Friday (06-05) precedes the next 13th
    // (06-13). OR semantics fire on the Friday; AND would defer to the next
    // Friday-the-13th (2026-11-13).
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 0, 0, 0, 0));

    const next = getNextCronDate('0 0 13 * 5');

    expect(next.getMonth()).toBe(5); // June
    expect(next.getDate()).toBe(5);
    expect(next.getDay()).toBe(5); // Friday
    expect(next.getTime()).toBeLessThan(new Date(2026, 5, 13).getTime());
  });

  it('matches the day-of-month even when it is not the restricted weekday', () => {
    // From Sat 2026-09-12 23:00 the next 13th (Sun 2026-09-13) precedes the
    // next Friday (2026-09-18) and is not itself a Friday — DOM fires alone.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 12, 23, 0, 0, 0));

    const next = getNextCronDate('0 0 13 * 5');

    expect(next.getMonth()).toBe(8);
    expect(next.getDate()).toBe(13);
    expect(next.getDay()).toBe(0); // Sunday, not Friday
  });

  it('applies only the restricted field when the other is wildcard', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 0, 0, 0, 0));

    // DOW-only: next Friday.
    expect(getNextCronDate('0 0 * * 5').getDay()).toBe(5);
    // DOM-only: next 13th regardless of weekday.
    expect(getNextCronDate('0 0 13 * *').getDate()).toBe(13);
  });

  it('treats day-of-week 0 and 7 as Sunday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 0, 0, 0, 0));

    const viaZero = getNextCronDate('0 0 * * 0');
    const viaSeven = getNextCronDate('0 0 * * 7');

    expect(viaZero.getDay()).toBe(0);
    expect(viaSeven.getTime()).toBe(viaZero.getTime());
  });
});

describe('ScheduleRunner getNextCronDate — list, range, and step terms', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches every term of a mixed range/value list', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 6, 0, 0, 0));

    // `1-5,10`: after 06:00 the 10:00 term must fire, not be dropped by
    // parsing the whole list as the range `1-5`.
    const next = getNextCronDate('0 1-5,10 * * *');
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(10);
  });

  it('does not widen a value-then-range list into one range', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 6, 1, 0, 0));

    // `0,30-40`: 06:02 is not in the list, the next match is 06:30.
    const next = getNextCronDate('0,30-40 * * * *');
    expect(next.getHours()).toBe(6);
    expect(next.getMinutes()).toBe(30);
  });

  it('steps `*/n` from the field minimum for day-of-month', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0, 0));

    // Day-of-month starts at 1, so `*/2` is 1,3,5,… — after June 1 noon the
    // next run is June 3, not June 2.
    const next = getNextCronDate('0 0 */2 * *');
    expect(next.getMonth()).toBe(5);
    expect(next.getDate()).toBe(3);
  });

  it('steps `base/n` from base to the field maximum', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 6, 21, 0, 0));

    // `5/15` is 5,20,35,50.
    const next = getNextCronDate('5/15 * * * *');
    expect(next.getHours()).toBe(6);
    expect(next.getMinutes()).toBe(35);
  });
});
