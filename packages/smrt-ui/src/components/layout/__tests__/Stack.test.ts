import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Stack from '../Stack.svelte';

const kids = createRawSnippet(() => ({
  render: () => '<span>One</span>',
}));

function stackEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    '[data-smrt-component="Stack"]',
  );
  if (!el) throw new Error('stack not found');
  return el;
}

describe('Stack', () => {
  it('renders children vertically with the md gap by default', () => {
    const { container } = render(Stack, { props: { children: kids } });
    expect(screen.getByText('One')).toBeInTheDocument();
    const el = stackEl(container);
    expect(el).toHaveClass('stack-vertical', 'gap-md');
    expect(el).not.toHaveClass('wrap');
    expect(el).not.toHaveAttribute('data-align');
  });

  it('maps direction, gap, align, justify and wrap', () => {
    const { container } = render(Stack, {
      props: {
        direction: 'horizontal',
        gap: 'lg',
        align: 'center',
        justify: 'between',
        wrap: true,
        children: kids,
      },
    });
    const el = stackEl(container);
    expect(el).toHaveClass('stack-horizontal', 'gap-lg', 'wrap');
    expect(el).toHaveAttribute('data-align', 'center');
    expect(el).toHaveAttribute('data-justify', 'between');
  });

  it('passes attributes and classes through', () => {
    const { container } = render(Stack, {
      props: { class: 'extra', 'data-testid': 's', children: kids },
    });
    const el = stackEl(container);
    expect(el).toHaveClass('extra');
    expect(el).toHaveAttribute('data-testid', 's');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(Stack, { props: { children: kids } });
    await expectNoA11yViolations(container);
  });
});
