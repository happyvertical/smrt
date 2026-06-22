/**
 * Component tests for the Grid layout primitive (Sweep S11, #1416).
 *
 * Asserts the column/gap/alignment prop API maps to the expected
 * classes/inline styles, snippet rendering, attribute pass-through, and
 * axe-clean output.
 */
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Grid from '../Grid.svelte';

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

/** The grid element is the `.grid` div (the header lives in a sibling div). */
function gridEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('div.grid');
  if (!el) throw new Error('grid element not found');
  return el;
}

describe('Grid', () => {
  it('renders slotted children', () => {
    render(Grid, { props: { children: textSnippet('Cell') } });
    expect(screen.getByText('Cell')).toBeInTheDocument();
  });

  it('uses auto-fill grid-template-columns by default (columns=auto)', () => {
    const { container } = render(Grid, {
      props: { children: textSnippet('x') },
    });
    expect(gridEl(container).getAttribute('style')).toContain(
      'grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))',
    );
  });

  it('maps a numeric column count to a fixed-column template', () => {
    const { container } = render(Grid, {
      props: { columns: 3, children: textSnippet('x') },
    });
    expect(gridEl(container).getAttribute('style')).toContain(
      'grid-template-columns: repeat(3, 1fr)',
    );
  });

  it('emits responsive CSS variables and the grid-responsive class for a responsive columns object', () => {
    const { container } = render(Grid, {
      props: { columns: { md: 2, xl: 4 }, children: textSnippet('x') },
    });
    const el = gridEl(container);
    expect(el).toHaveClass('grid-responsive');
    const style = el.getAttribute('style') ?? '';
    expect(style).toContain('--grid-columns-md: 2');
    expect(style).toContain('--grid-columns-xl: 4');
    // Unspecified breakpoints are not emitted (CSS cascade handles inheritance).
    expect(style).not.toContain('--grid-columns-sm');
  });

  it('applies a uniform gap class when row and column gaps match (default md)', () => {
    const { container } = render(Grid, {
      props: { children: textSnippet('x') },
    });
    expect(gridEl(container)).toHaveClass('gap-md');
  });

  it.each([
    'sm',
    'md',
    'lg',
    'xl',
  ] as const)('maps a uniform gap=%s to gap-%s', (gap) => {
    const { container } = render(Grid, {
      props: { gap, children: textSnippet('x') },
    });
    expect(gridEl(container)).toHaveClass(`gap-${gap}`);
  });

  it('splits row/column gap classes when they differ', () => {
    const { container } = render(Grid, {
      props: { gap: { row: 'sm', column: 'lg' }, children: textSnippet('x') },
    });
    const el = gridEl(container);
    expect(el).toHaveClass('row-gap-sm', 'col-gap-lg');
    expect(el).not.toHaveClass('gap-sm');
  });

  it('maps alignItems / justifyItems / autoFlow to inline styles', () => {
    const { container } = render(Grid, {
      props: {
        alignItems: 'center',
        justifyItems: 'end',
        autoFlow: 'column',
        children: textSnippet('x'),
      },
    });
    const style = gridEl(container).getAttribute('style') ?? '';
    expect(style).toContain('align-items: center');
    expect(style).toContain('justify-items: end');
    expect(style).toContain('grid-auto-flow: column');
  });

  it('renders the header snippet above the grid', () => {
    render(Grid, {
      props: {
        header: textSnippet('Grid Heading'),
        children: textSnippet('Cell'),
      },
    });
    expect(screen.getByText('Grid Heading')).toBeInTheDocument();
  });

  it('passes ...rest attributes through to the grid element', () => {
    const { container } = render(Grid, {
      props: {
        children: textSnippet('x'),
        id: 'gallery',
        'data-testid': 'grid',
      },
    });
    const el = gridEl(container);
    expect(el).toHaveAttribute('id', 'gallery');
    expect(el).toHaveAttribute('data-testid', 'grid');
  });

  it('is axe-clean with content', async () => {
    const { container } = render(Grid, {
      props: {
        header: textSnippet('Items'),
        children: textSnippet('Accessible cell'),
      },
    });
    await expectNoA11yViolations(container);
  });
});
