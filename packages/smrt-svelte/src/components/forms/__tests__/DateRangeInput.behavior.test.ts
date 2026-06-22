/**
 * Behavior tests for DateRangeInput (Sweep S11, #1416).
 *
 * In default mode the component renders two native date pickers (Start / End)
 * with cross-linked min/max, emits a { startDate, endDate } range via
 * onchange, and validates start <= end. The hooks throw outside a <Provider>,
 * so useAppState (default mode) + useSTT (stub) are mocked.
 */

import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));
vi.mock('../../../hooks/useSTT.svelte.js', () => ({
  useSTT: () => ({
    isListening: false,
    isInitializing: false,
    isReady: false,
    adapterType: null,
    downloadProgress: 0,
    lastResult: '',
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

import DateRangeInput from '../DateRangeInput.svelte';

describe('DateRangeInput — behavior', () => {
  it('renders labelled Start and End date pickers', () => {
    render(DateRangeInput, { props: { name: 'range', label: 'Dates' } });
    expect(screen.getByLabelText('Start')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('End')).toHaveAttribute('type', 'date');
  });

  it('setting the start date emits the range with the new start', async () => {
    const onchange = vi.fn();
    render(DateRangeInput, {
      props: { name: 'range', label: 'Dates', onchange },
    });
    await fireEvent.change(screen.getByLabelText('Start'), {
      target: { value: '2024-01-10' },
    });
    expect(onchange).toHaveBeenLastCalledWith({
      startDate: '2024-01-10',
      endDate: '',
    });
  });

  it('setting both dates emits the full range', async () => {
    const onchange = vi.fn();
    render(DateRangeInput, {
      props: {
        name: 'range',
        label: 'Dates',
        startDate: '2024-01-10',
        onchange,
      },
    });
    await fireEvent.change(screen.getByLabelText('End'), {
      target: { value: '2024-03-20' },
    });
    expect(onchange).toHaveBeenLastCalledWith({
      startDate: '2024-01-10',
      endDate: '2024-03-20',
    });
  });

  it('flags an end-before-start range as invalid with a linked alert', () => {
    render(DateRangeInput, {
      props: {
        name: 'range',
        label: 'Dates',
        startDate: '2024-05-01',
        endDate: '2024-01-01',
      },
    });
    const start = screen.getByLabelText('Start');
    expect(start).toHaveAttribute('aria-invalid', 'true');
    expect(start).toHaveAttribute('aria-describedby', 'range-error');
    const err = document.getElementById('range-error');
    expect(err).toHaveAttribute('role', 'alert');
    expect(err).toHaveTextContent('End date must be after start date');
  });

  it('treats start <= end as a valid range (no error)', () => {
    render(DateRangeInput, {
      props: {
        name: 'range',
        label: 'Dates',
        startDate: '2024-01-01',
        endDate: '2024-05-01',
      },
    });
    expect(screen.getByLabelText('Start')).not.toHaveAttribute('aria-invalid');
    expect(document.getElementById('range-error')).toBeNull();
  });

  it('caps the start picker max at the chosen end date', () => {
    render(DateRangeInput, {
      props: { name: 'range', label: 'Dates', endDate: '2024-03-20' },
    });
    expect(screen.getByLabelText('Start')).toHaveAttribute('max', '2024-03-20');
  });

  it('floors the end picker min at the chosen start date', () => {
    render(DateRangeInput, {
      props: { name: 'range', label: 'Dates', startDate: '2024-01-10' },
    });
    expect(screen.getByLabelText('End')).toHaveAttribute('min', '2024-01-10');
  });

  it('mirrors the dates into hidden submission inputs', async () => {
    const { container } = render(DateRangeInput, {
      props: { name: 'range', label: 'Dates', startDate: '2024-01-10' },
    });
    await fireEvent.change(screen.getByLabelText('End'), {
      target: { value: '2024-03-20' },
    });
    expect(
      container.querySelector<HTMLInputElement>('input[name="range_start"]'),
    ).toHaveValue('2024-01-10');
    expect(
      container.querySelector<HTMLInputElement>('input[name="range_end"]'),
    ).toHaveValue('2024-03-20');
  });

  it('renders an explicit error prop as a linked alert', () => {
    render(DateRangeInput, {
      props: { name: 'range', label: 'Dates', error: 'Pick a range' },
    });
    const err = document.getElementById('range-error');
    expect(err).toHaveTextContent('Pick a range');
    expect(err).toHaveAttribute('role', 'alert');
  });

  it('is axe-clean in a labelled + error state', async () => {
    const { container } = render(DateRangeInput, {
      props: {
        name: 'range',
        label: 'Dates',
        startDate: '2024-05-01',
        endDate: '2024-01-01',
      },
    });
    await expectNoA11yViolations(container);
  });
});
