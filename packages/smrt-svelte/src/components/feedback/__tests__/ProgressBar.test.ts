/**
 * Golden test for ProgressBar (Sweep S11, #1416).
 *
 * ProgressBar renders a `role="progressbar"` track carrying
 * `aria-valuenow`/`aria-valuemin`/`aria-valuemax` from its `value`/`max` props.
 * An optional header shows a percentage, a value/max pair, or a custom label,
 * plus an "over by" badge when `value` exceeds `max`.
 */
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import ProgressBar from '../ProgressBar.svelte';

describe('ProgressBar', () => {
  it('gives the progressbar an accessible name (default and custom label)', () => {
    const { rerender } = render(ProgressBar, { props: { value: 40 } });
    // Default accessible name comes from the i18n'd "Progress" label.
    expect(
      screen.getByRole('progressbar', { name: 'Progress' }),
    ).toBeInTheDocument();
    rerender({ value: 40, label: 'Upload' });
    expect(
      screen.getByRole('progressbar', { name: 'Upload' }),
    ).toBeInTheDocument();
  });

  it('exposes progressbar role with aria-value attributes', () => {
    render(ProgressBar, { props: { value: 40 } });
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('reflects a custom max in aria-valuemax', () => {
    render(ProgressBar, { props: { value: 30, max: 200 } });
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '30');
    expect(bar).toHaveAttribute('aria-valuemax', '200');
  });

  it('does not render a label by default', () => {
    render(ProgressBar, { props: { value: 25 } });
    expect(screen.queryByText('25%')).toBeNull();
  });

  it('shows a rounded percentage label when showLabel is set', () => {
    render(ProgressBar, { props: { value: 33, showLabel: true } });
    expect(screen.getByText('33%')).toBeInTheDocument();
  });

  it('shows a value / max label when showValue is set', () => {
    render(ProgressBar, { props: { value: 75, max: 100, showValue: true } });
    expect(screen.getByText('75 / 100')).toBeInTheDocument();
  });

  it('prefers a custom label over percentage and value', () => {
    render(ProgressBar, {
      props: { value: 50, showLabel: true, label: 'Almost there' },
    });
    expect(screen.getByText('Almost there')).toBeInTheDocument();
    expect(screen.queryByText('50%')).toBeNull();
  });

  it('caps aria-valuenow display semantics but reports the raw over-budget value', () => {
    render(ProgressBar, { props: { value: 120, max: 100, showLabel: true } });
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '120');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByText('Over by 20')).toBeInTheDocument();
  });

  it('is axe-clean at 0%', async () => {
    const { container } = render(ProgressBar, {
      props: { value: 0, showLabel: true },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean mid-progress', async () => {
    const { container } = render(ProgressBar, {
      props: { value: 50, showLabel: true },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean at 100%', async () => {
    const { container } = render(ProgressBar, {
      props: { value: 100, showLabel: true },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean in the over-budget state', async () => {
    const { container } = render(ProgressBar, {
      props: { value: 130, max: 100, showValue: true },
    });
    await expectNoA11yViolations(container);
  });
});
