/**
 * Component test for Badge (Sweep S11, #1416).
 *
 * Badge is a presentational `<span>` — it renders children plus variant/size
 * classes and forwards rest attributes. This suite asserts that real API
 * (props from Badge.svelte) and proves the output is axe-clean.
 */
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Badge from '../Badge.svelte';

/** Build a text Snippet for the Badge's `children` prop. */
function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe('Badge', () => {
  it('renders its children content', () => {
    render(Badge, { props: { children: textSnippet('New') } });
    expect(screen.getByText('New')).toBeInTheDocument();
  });

  it('applies the default variant and md size classes', () => {
    const { container } = render(Badge, {
      props: { children: textSnippet('Default') },
    });
    const badge = container.querySelector('.badge');
    expect(badge).toHaveClass('default');
    expect(badge).toHaveClass('md');
  });

  it.each([
    'primary',
    'success',
    'warning',
    'error',
    'info',
  ] as const)('reflects the %s variant as a class', (variant) => {
    const { container } = render(Badge, {
      props: { variant, children: textSnippet('Status') },
    });
    expect(container.querySelector('.badge')).toHaveClass(variant);
  });

  it('reflects the sm size as a class', () => {
    const { container } = render(Badge, {
      props: { size: 'sm', children: textSnippet('Small') },
    });
    expect(container.querySelector('.badge')).toHaveClass('sm');
  });

  it('forwards rest attributes (e.g. aria-label, data-testid) to the span', () => {
    const { container } = render(Badge, {
      props: {
        'aria-label': 'Unread count: 3',
        'data-testid': 'unread-badge',
        children: textSnippet('3'),
      },
    });
    const badge = container.querySelector('.badge');
    expect(badge).toHaveAttribute('aria-label', 'Unread count: 3');
    expect(badge).toHaveAttribute('data-testid', 'unread-badge');
  });

  it('is axe-clean for a default badge', async () => {
    const { container } = render(Badge, {
      props: { children: textSnippet('Accessible') },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean for a variant badge with an accessible label', async () => {
    const { container } = render(Badge, {
      props: {
        variant: 'error',
        'aria-label': '5 errors',
        children: textSnippet('5'),
      },
    });
    await expectNoA11yViolations(container);
  });
});
