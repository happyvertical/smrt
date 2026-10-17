/** Time bucket labels and the line chart's axis and value readout (#4100). */
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Chart from '../Chart.svelte';
import { formatTimeBucket } from '../format.js';

describe('formatTimeBucket', () => {
  it.each([
    ['2025-01-01T00:00:00.000Z', 'month', 'Jan 2025'],
    ['2025-04-01 00:00:00', 'quarter', 'Q2 2025'],
    ['2025-01-01T00:00:00.000Z', 'year', '2025'],
    ['2025-03-03T00:00:00.000Z', 'week', 'Mar 3'],
    ['2025-03-03T14:00:00.000Z', 'hour', 'Mar 3, 14:00'],
    ['not a date', 'month', 'not a date'],
  ] as const)('%s by %s reads %s', (value, unit, label) => {
    expect(formatTimeBucket(value, unit, 'en')).toBe(label);
  });
});

describe('line chart', () => {
  const months = Array.from({ length: 12 }, (_, i) => ({
    label: formatTimeBucket(
      new Date(Date.UTC(2025, i, 1)).toISOString(),
      'month',
      'en',
    ),
    value: (i + 1) * 1000,
  }));

  it('thins the axis to three labels and reads out the peak and latest', () => {
    render(Chart, {
      data: { points: months, format: 'money', currency: 'USD' },
      style: 'line',
      title: 'Total amount',
    });
    const axis = document.querySelector('.smrt-chart__axis');
    expect([...(axis?.children ?? [])].map((el) => el.textContent)).toEqual([
      'Jan 2025',
      'Jun 2025',
      'Dec 2025',
    ]);
    expect(screen.getByText('Peak $120.00 · Dec 2025')).toBeTruthy();
    expect(screen.getByText('Latest $120.00 · Dec 2025')).toBeTruthy();
  });
});
