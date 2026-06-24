/**
 * Component tests for the SummaryCard layout primitive (Sweep S11, #1416).
 *
 * Asserts the label/value render, the optional count badge and icon, the
 * variant→value-color-class mapping, the clickable link variant, and
 * axe-clean output across a couple of states.
 */
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import SummaryCard from '../SummaryCard.svelte';

describe('SummaryCard', () => {
  it('renders the label and value', () => {
    render(SummaryCard, { props: { label: 'Revenue', value: '$1,200' } });
    expect(screen.getByText('Revenue')).toBeInTheDocument();
    expect(screen.getByText('$1,200')).toBeInTheDocument();
  });

  it('renders a numeric value', () => {
    render(SummaryCard, { props: { label: 'Orders', value: 42 } });
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders the optional count badge', () => {
    const { container } = render(SummaryCard, {
      props: { label: 'Tasks', value: 'Open', count: 7 },
    });
    expect(container.querySelector('.card-count')).toHaveTextContent('7');
  });

  it('renders a count badge of 0 (undefined check, not falsy)', () => {
    const { container } = render(SummaryCard, {
      props: { label: 'Tasks', value: 'Done', count: 0 },
    });
    expect(container.querySelector('.card-count')).toHaveTextContent('0');
  });

  it('omits the count badge when count is undefined', () => {
    const { container } = render(SummaryCard, {
      props: { label: 'Tasks', value: 'Open' },
    });
    expect(container.querySelector('.card-count')).toBeNull();
  });

  it('renders an icon via the Icon component when icon is a known name', () => {
    const { container } = render(SummaryCard, {
      // `search` is a real Icon preset, so the rendered <path> must carry a
      // non-empty `d` — proving the icon-name path actually resolved (an
      // unknown name would still render an <svg> but with an empty path).
      props: { label: 'Visitors', value: 99, icon: 'search' },
    });
    const iconPath = container.querySelector('.card-icon svg path');
    expect(iconPath?.getAttribute('d')).toBeTruthy();
  });

  it('does NOT inject a raw SVG string as markup (no {@html} sink) — #1591', () => {
    const { container } = render(SummaryCard, {
      props: {
        label: 'Visitors',
        value: 99,
        // A would-be XSS payload: the string is forwarded to <Icon name>, never
        // rendered as HTML, so the attacker-controlled element must be absent.
        icon: '<svg data-evil="1" viewBox="0 0 24 24"></svg>',
      },
    });
    expect(container.querySelector('svg[data-evil]')).toBeNull();
  });

  it('renders custom icon markup via the iconContent snippet', () => {
    const iconContent = createRawSnippet(() => ({
      render: () => '<span data-testid="custom-icon">★</span>',
    }));
    const { container } = render(SummaryCard, {
      props: { label: 'Starred', value: 1, iconContent },
    });
    expect(
      container.querySelector('.card-icon [data-testid="custom-icon"]'),
    ).not.toBeNull();
  });

  it('renders as a clickable link when href is provided', () => {
    render(SummaryCard, {
      props: { label: 'Reports', value: 12, href: '/reports' },
    });
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/reports');
    expect(link).toHaveClass('clickable');
  });

  it('applies the highlight class when highlight is set', () => {
    const { container } = render(SummaryCard, {
      props: { label: 'Featured', value: 1, highlight: true },
    });
    expect(container.querySelector('.summary-card')).toHaveClass('highlight');
  });

  it.each([
    ['default', 'color-default'],
    ['success', 'color-success'],
    ['warning', 'color-warning'],
    ['danger', 'color-error'],
  ] as const)('maps variant=%s to the %s value class', (variant, expected) => {
    const { container } = render(SummaryCard, {
      props: { label: 'Metric', value: 5, variant },
    });
    expect(container.querySelector('.card-value')).toHaveClass(expected);
  });

  it.each([
    { label: 'Static', value: '$10' },
    { label: 'Linked', value: 3, href: '/go', count: 2 },
  ])('is axe-clean (%o)', async (props) => {
    const { container } = render(SummaryCard, { props });
    await expectNoA11yViolations(container);
  });
});
