/** Time bucket labels and the line chart's axis and value readout (#4100). */
import { fireEvent, render, screen } from '@testing-library/svelte';
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

describe('line chart sizes and exploring', () => {
  const points = [
    { label: 'Jan 2025', value: 120_000 },
    { label: 'Feb 2025', value: 8_338_000 },
    { label: 'Mar 2025', value: 2_845_000 },
  ];

  it('draws a compact sparkline with no axis, readout or slider', () => {
    render(Chart, {
      data: { points, format: 'money', currency: 'USD' },
      style: 'line',
      title: 'Total amount',
      size: 'compact',
    });
    expect(document.querySelector('.smrt-chart__axis')).toBeNull();
    expect(document.querySelector('.smrt-chart__readout')).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('img', { name: /Total amount/ })).toBeTruthy();
  });

  it('labels the value axis of a tall chart in round steps, short form', () => {
    render(Chart, {
      data: { points, format: 'money', currency: 'USD' },
      style: 'line',
      title: 'Total amount',
      size: 'tall',
    });
    const values = document.querySelector('.smrt-chart__values');
    expect([...(values?.children ?? [])].map((el) => el.textContent)).toEqual([
      '$100K',
      '$50K',
      '$0',
    ]);
  });

  it('reads each value with the arrow keys', async () => {
    render(Chart, {
      data: { points, format: 'money', currency: 'USD' },
      style: 'line',
      title: 'Total amount',
      explore: true,
    });
    const slider = screen.getByRole('slider', { name: /Total amount/ });
    expect(slider.getAttribute('aria-valuetext')).toBe('Mar 2025: $28,450.00');
    slider.focus();
    await fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider.getAttribute('aria-valuetext')).toBe('Jan 2025: $1,200.00');
    expect(document.querySelector('.smrt-chart__tip')?.textContent).toBe(
      'Jan 2025$1,200.00',
    );
    await fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuenow')).toBe('1');
    await fireEvent.blur(slider);
    expect(document.querySelector('.smrt-chart__tip')).toBeNull();
  });
});
