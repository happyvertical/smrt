/**
 * Component tests for the Container layout primitive (Sweep S11, #1416).
 *
 * Mirrors the Button golden pattern: render via Testing Library, assert the
 * rendered DOM/class/attribute API, and prove axe-clean output.
 */
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Container from '../Container.svelte';

/** Build a text Snippet for the `children` prop. */
function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe('Container', () => {
  it('renders slotted children', () => {
    render(Container, { props: { children: textSnippet('Inside') } });
    expect(screen.getByText('Inside')).toBeInTheDocument();
  });

  it('applies the default lg max-width class', () => {
    const { container } = render(Container, {
      props: { children: textSnippet('x') },
    });
    const div = container.querySelector('div.container');
    expect(div).not.toBeNull();
    expect(div).toHaveClass('container', 'max-w-lg');
  });

  it.each([
    'sm',
    'md',
    'lg',
    'xl',
    'full',
  ] as const)('maps maxWidth=%s to the max-w-%s class', (maxWidth) => {
    const { container } = render(Container, {
      props: { maxWidth, children: textSnippet('x') },
    });
    expect(container.querySelector('div.container')).toHaveClass(
      `max-w-${maxWidth}`,
    );
  });

  it('passes ...rest attributes through to the root element', () => {
    const { container } = render(Container, {
      props: {
        children: textSnippet('x'),
        id: 'main-region',
        'data-testid': 'wrap',
        role: 'region',
        'aria-label': 'Main content',
      },
    });
    const div = container.querySelector('div.container');
    expect(div).toHaveAttribute('id', 'main-region');
    expect(div).toHaveAttribute('data-testid', 'wrap');
    expect(screen.getByRole('region', { name: 'Main content' })).toBe(div);
  });

  it('is axe-clean with content', async () => {
    const { container } = render(Container, {
      props: { children: textSnippet('Accessible content') },
    });
    await expectNoA11yViolations(container);
  });
});
