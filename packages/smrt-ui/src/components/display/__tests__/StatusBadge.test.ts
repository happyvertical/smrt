/**
 * Component tests for StatusBadge (Sweep S11, #1416).
 *
 * StatusBadge is a presentational chip: it normalizes a status string, maps it
 * to a color scheme per domain `type`, and renders a humanized label. Tests
 * assert the real API from StatusBadge.svelte — label formatting, custom label
 * override, size/variant classes, scheme-driven CSS custom properties, and
 * axe-cleanliness across variants.
 */
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import StatusBadge from '../StatusBadge.svelte';

describe('StatusBadge', () => {
  it('renders the status value as its label', () => {
    render(StatusBadge, { props: { status: 'active' } });
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('humanizes underscores in the status into spaces', () => {
    render(StatusBadge, { props: { status: 'on_hold', type: 'project' } });
    expect(screen.getByText('on hold')).toBeInTheDocument();
  });

  it('prefers an explicit label over the status value', () => {
    render(StatusBadge, {
      props: { status: 'paid', type: 'invoice', label: 'Paid in full' },
    });
    expect(screen.getByText('Paid in full')).toBeInTheDocument();
    expect(screen.queryByText('paid')).not.toBeInTheDocument();
  });

  it('always carries the base status-badge class', () => {
    const { container } = render(StatusBadge, { props: { status: 'active' } });
    expect(container.querySelector('span')).toHaveClass('status-badge');
  });

  it.each([
    ['sm', 'sm'],
    ['lg', 'lg'],
  ] as const)('applies the %s size class', (size, cls) => {
    const { container } = render(StatusBadge, {
      props: { status: 'active', size },
    });
    expect(container.querySelector('span')).toHaveClass(cls);
  });

  it('omits a size class for the default md size', () => {
    const { container } = render(StatusBadge, { props: { status: 'active' } });
    const span = container.querySelector('span');
    expect(span).not.toHaveClass('sm');
    expect(span).not.toHaveClass('lg');
  });

  it('applies the outline class for the outline variant', () => {
    const { container } = render(StatusBadge, {
      props: { status: 'active', variant: 'outline' },
    });
    expect(container.querySelector('span')).toHaveClass('outline');
  });

  it('maps a known status to its scheme colors via CSS custom properties', () => {
    const { container } = render(StatusBadge, {
      props: { status: 'overdue', type: 'invoice' },
    });
    const span = container.querySelector('span') as HTMLElement;
    // invoice/overdue → error container scheme
    expect(span.style.getPropertyValue('--badge-bg')).toContain(
      'smrt-color-error-container',
    );
    expect(span.style.getPropertyValue('--badge-text')).toContain(
      'smrt-color-on-error-container',
    );
  });

  it('falls back to a neutral scheme for an unknown status', () => {
    const { container } = render(StatusBadge, {
      props: { status: 'totally-unknown', type: 'invoice' },
    });
    const span = container.querySelector('span') as HTMLElement;
    // The neutral fallback resolves to canonical surface tokens, not a literal
    // hex. smrt-ui owns the theme system, so the tokens are always defined; a
    // hardcoded fallback would freeze the wrong color across presets (#1586).
    expect(span.style.getPropertyValue('--badge-bg')).toBe(
      'var(--smrt-color-surface-container-highest)',
    );
    expect(span.style.getPropertyValue('--badge-text')).toBe(
      'var(--smrt-color-on-surface-variant)',
    );
  });

  it('uses bare design tokens with no literal hex fallback in scheme colors', () => {
    // Regression for #1586: the `var(--token, #hex)` fallbacks were the wrong
    // colors (e.g. primary-container → green #dcfce7 vs real material light blue
    // #d3e3fd). Every emitted custom property must be a bare token reference.
    const { container } = render(StatusBadge, {
      props: { status: 'paid', type: 'invoice' },
    });
    const span = container.querySelector('span') as HTMLElement;
    expect(span.style.getPropertyValue('--badge-bg')).toBe(
      'var(--smrt-color-primary-container)',
    );
    expect(span.style.getPropertyValue('--badge-bg')).not.toContain('#');
    expect(span.style.getPropertyValue('--badge-text')).not.toContain('#');
  });

  it('normalizes spaces and hyphens when matching a scheme key', () => {
    // 'On-Hold' normalizes to 'on_hold', a known project status.
    const { container } = render(StatusBadge, {
      props: { status: 'On-Hold', type: 'project' },
    });
    const span = container.querySelector('span') as HTMLElement;
    expect(span.style.getPropertyValue('--badge-bg')).toContain(
      'smrt-color-secondary-container',
    );
  });

  it.each([
    ['default', 'active'],
    ['invoice', 'paid'],
    ['project', 'completed'],
    ['expense', 'reimbursed'],
    ['time', 'approved'],
    ['compliance', 'valid'],
    ['estimate', 'accepted'],
  ] as const)('is axe-clean for type=%s status=%s', async (type, status) => {
    const { container } = render(StatusBadge, { props: { status, type } });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean for the outline variant', async () => {
    const { container } = render(StatusBadge, {
      props: { status: 'active', variant: 'outline' },
    });
    await expectNoA11yViolations(container);
  });
});
