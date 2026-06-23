/**
 * Component tests for ConfidenceBadge (Sweep S11, #1416).
 *
 * ConfidenceBadge renders an ARIA meter for a 0-100 confidence score. Tests
 * assert the real API from ConfidenceBadge.svelte — meter semantics
 * (aria-valuenow/min/max/text), the >=80/>=50/else level→color mapping,
 * clamping of out-of-range input, percent visibility, default vs custom
 * aria-label, and axe-cleanliness across levels.
 */
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import ConfidenceBadge from '../ConfidenceBadge.svelte';

describe('ConfidenceBadge', () => {
  it('exposes meter semantics with the confidence as aria-valuenow', () => {
    render(ConfidenceBadge, { props: { confidence: 73 } });
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '73');
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
  });

  it('shows the rounded percentage by default', () => {
    render(ConfidenceBadge, { props: { confidence: 73.4 } });
    expect(screen.getByText('73%')).toBeInTheDocument();
  });

  it('hides the percentage text when showPercent is false', () => {
    render(ConfidenceBadge, { props: { confidence: 73, showPercent: false } });
    expect(screen.queryByText('73%')).not.toBeInTheDocument();
  });

  it('derives a default aria-label from the rounded confidence', () => {
    render(ConfidenceBadge, { props: { confidence: 91.6 } });
    expect(screen.getByRole('meter')).toHaveAttribute(
      'aria-label',
      'Confidence: 92%',
    );
  });

  it('uses a custom aria-label when provided', () => {
    render(ConfidenceBadge, {
      props: { confidence: 50, 'aria-label': 'OCR certainty' },
    });
    expect(screen.getByRole('meter')).toHaveAttribute(
      'aria-label',
      'OCR certainty',
    );
  });

  it.each([
    [95, 'high'],
    [80, 'high'],
    [65, 'medium'],
    [50, 'medium'],
    [30, 'low'],
    [0, 'low'],
  ])('reports "%s%%" as %s confidence in aria-valuetext', (value, level) => {
    render(ConfidenceBadge, { props: { confidence: value } });
    expect(screen.getByRole('meter')).toHaveAttribute(
      'aria-valuetext',
      `${level} confidence (${value}%)`,
    );
  });

  it('clamps confidence above 100 down to 100', () => {
    render(ConfidenceBadge, { props: { confidence: 150 } });
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('clamps negative confidence up to 0', () => {
    render(ConfidenceBadge, { props: { confidence: -20 } });
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it.each([
    [90, 'primary'],
    [60, 'secondary'],
    [20, 'error'],
  ])('maps %s%% to the %s color token for the bar', (value, token) => {
    const { container } = render(ConfidenceBadge, {
      props: { confidence: value },
    });
    const badge = container.querySelector('.confidence-badge') as HTMLElement;
    expect(badge.style.getPropertyValue('--bar-color')).toContain(
      `smrt-color-${token}`,
    );
  });

  it('emits bare design tokens with no literal hex fallback', () => {
    // Regression for #1586: the old `var(--token, #hex)` fallbacks were the
    // wrong colors (high → green #dcfce7 vs real material light blue #d3e3fd).
    const { container } = render(ConfidenceBadge, {
      props: { confidence: 90 },
    });
    const badge = container.querySelector('.confidence-badge') as HTMLElement;
    for (const prop of ['--badge-bg', '--badge-text', '--bar-color']) {
      const value = badge.style.getPropertyValue(prop);
      expect(value).toMatch(/^var\(--smrt-color-[a-z-]+\)$/);
      expect(value).not.toContain('#');
    }
  });

  it('appends a custom class alongside the base class', () => {
    const { container } = render(ConfidenceBadge, {
      props: { confidence: 50, class: 'my-badge' },
    });
    const badge = container.querySelector('.confidence-badge');
    expect(badge).toHaveClass('my-badge');
  });

  it.each([
    ['sm', 'sm'],
    ['lg', 'lg'],
  ] as const)('applies the %s size class', (size, cls) => {
    const { container } = render(ConfidenceBadge, {
      props: { confidence: 50, size },
    });
    expect(container.querySelector('.confidence-badge')).toHaveClass(cls);
  });

  it.each([10, 60, 95])('is axe-clean at %s%% confidence', async (value) => {
    const { container } = render(ConfidenceBadge, {
      props: { confidence: value },
    });
    await expectNoA11yViolations(container);
  });
});
