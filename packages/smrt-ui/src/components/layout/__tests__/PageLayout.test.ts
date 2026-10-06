import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import PageLayout from '../PageLayout.svelte';

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<p>${text}</p>` }));
}

describe('PageLayout', () => {
  it('provides the default content width and vertical rhythm', () => {
    const { container } = render(PageLayout, {
      props: { children: textSnippet('Page content') },
    });

    expect(container.querySelector('[data-page-layout-container]')).toHaveClass(
      'max-w-lg',
    );
    expect(container.querySelector('[data-page-layout]')).toHaveClass(
      'page-layout',
      'gap-md',
    );
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });

  it.each([
    'sm',
    'md',
    'lg',
    'xl',
    'full',
  ] as const)('maps maxWidth=%s to the shared container', (maxWidth) => {
    const { container } = render(PageLayout, {
      props: { maxWidth, children: textSnippet('x') },
    });
    expect(container.querySelector('[data-page-layout-container]')).toHaveClass(
      `max-w-${maxWidth}`,
    );
  });

  it.each([
    'sm',
    'md',
    'lg',
  ] as const)('maps gap=%s to the page stack', (gap) => {
    const { container } = render(PageLayout, {
      props: { gap, children: textSnippet('x') },
    });
    expect(container.querySelector('[data-page-layout]')).toHaveClass(
      `gap-${gap}`,
    );
  });

  it('forwards semantic attributes and consumer classes to the content element', () => {
    render(PageLayout, {
      props: {
        class: 'account-page',
        role: 'region',
        'aria-label': 'Account settings',
        'data-testid': 'page',
        children: textSnippet('x'),
      },
    });
    expect(
      screen.getByRole('region', { name: 'Account settings' }),
    ).toHaveClass('page-layout', 'account-page');
    expect(screen.getByTestId('page')).toHaveAttribute('data-page-layout');
  });

  it('is axe-clean', async () => {
    const { container } = render(PageLayout, {
      props: { children: textSnippet('Accessible page') },
    });
    await expectNoA11yViolations(container);
  });
});
