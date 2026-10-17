/**
 * Time language for runtime reports (#4100), resolved against a fixed clock.
 */
import { describe, expect, it } from 'vitest';
import {
  parseRuntimeReportTime,
  resolveRuntimeReportTimeRange,
  runtimeReportBucketForSpan,
} from '../runtime-time.js';

// Thursday 16 October 2026, mid-afternoon UTC.
const NOW = new Date('2026-10-16T15:30:00.000Z');
const range = (phrase: string) => resolveRuntimeReportTimeRange(phrase, NOW);

describe('resolveRuntimeReportTimeRange', () => {
  it.each([
    ['today', '2026-10-16', '2026-10-17', 'today'],
    ['yesterday', '2026-10-15', '2026-10-16', 'yesterday'],
    ['this week', '2026-10-12', '2026-10-19', 'this week'],
    ['last week', '2026-10-05', '2026-10-12', 'last week'],
    ['last month', '2026-09-01', '2026-10-01', 'last month'],
    ['this month', '2026-10-01', '2026-11-01', 'this month'],
    ['last quarter', '2026-07-01', '2026-10-01', 'last quarter'],
    ['this quarter', '2026-10-01', '2027-01-01', 'this quarter'],
    ['this year', '2026-01-01', '2027-01-01', 'this year'],
    ['last year', '2025-01-01', '2026-01-01', 'last year'],
    ['last 90 days', '2026-07-19', '2026-10-17', 'last 90 days'],
    ['the past 2 weeks', '2026-10-03', '2026-10-17', 'last 2 weeks'],
    ['Q3', '2026-07-01', '2026-10-01', 'Q3 2026'],
    ['Q4', '2026-10-01', '2027-01-01', 'Q4 2026'],
    ['q1 2025', '2025-01-01', '2025-04-01', 'Q1 2025'],
    ['third quarter of 2024', '2024-07-01', '2024-10-01', 'Q3 2024'],
    ['year to date', '2026-01-01', '2026-10-17', 'year to date'],
    ['December', '2025-12-01', '2026-01-01', 'December 2025'],
    ['in March 2025', '2025-03-01', '2025-04-01', 'March 2025'],
    ['sales in 2024', '2024-01-01', '2025-01-01', '2024'],
    ['last_month', '2026-09-01', '2026-10-01', 'last month'],
  ])('%s', (phrase, from, to, label) => {
    expect(range(phrase)).toEqual({ from, to, label });
  });

  it('names no period for words without one', () => {
    expect(range('sales by month')).toBeNull();
    expect(range('what may we sell')).toBeNull();
    expect(range('all time')).toBeNull();
  });

  it('takes the latest started quarter or month when no year is given', () => {
    const may = new Date('2026-05-10T00:00:00Z');
    expect(resolveRuntimeReportTimeRange('Q3', may)?.label).toBe('Q3 2025');
    expect(resolveRuntimeReportTimeRange('November', may)?.label).toBe(
      'November 2025',
    );
  });
});

describe('parseRuntimeReportTime', () => {
  it.each([
    ['sales by month', 'month'],
    ['monthly revenue', 'month'],
    ['orders per week', 'week'],
    ['daily signups', 'day'],
    ['revenue quarterly', 'quarter'],
    ['year over year', 'year'],
    ['last quarter by week', 'week'],
  ])('%s groups by %s', (text, bucket) => {
    expect(parseRuntimeReportTime(text, NOW).bucket).toBe(bucket);
  });

  it('reads a grouping and a period together', () => {
    expect(parseRuntimeReportTime('last quarter by week', NOW)).toEqual({
      bucket: 'week',
      range: { from: '2026-07-01', to: '2026-10-01', label: 'last quarter' },
      mentionsTime: true,
    });
  });

  it('picks the "over time" grouping from the period length', () => {
    expect(parseRuntimeReportTime('sales over time', NOW).bucket).toBe('month');
    expect(
      parseRuntimeReportTime('sales over time last month', NOW).bucket,
    ).toBe('day');
    expect(
      parseRuntimeReportTime('trend for the last 90 days', NOW).bucket,
    ).toBe('week');
    expect(runtimeReportBucketForSpan(2000)).toBe('quarter');
  });

  it('notices time without a grouping or a period', () => {
    expect(parseRuntimeReportTime('the date month', NOW)).toEqual({
      mentionsTime: true,
    });
    expect(parseRuntimeReportTime('by status', NOW)).toEqual({
      mentionsTime: false,
    });
    // "last month" is a period, not a monthly grouping.
    expect(parseRuntimeReportTime('sales last month', NOW).bucket).toBe(
      undefined,
    );
  });
});
