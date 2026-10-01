import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import IconToggleGroup from '../IconToggleGroup.svelte';

const buttons = createRawSnippet(() => ({
  render: () =>
    '<span><button type="button" aria-pressed="true" aria-label="Draft (2)">D</button><button type="button" aria-pressed="false" aria-label="Review (0)">R</button></span>',
}));

describe('IconToggleGroup', () => {
  it('is a named group around its toggles', () => {
    render(IconToggleGroup, {
      props: { label: 'Filter by status', children: buttons },
    });
    const group = screen.getByRole('group', { name: 'Filter by status' });
    expect(group.querySelectorAll('button')).toHaveLength(2);
  });

  it('adds no state: the toggles keep their own pressed value', () => {
    render(IconToggleGroup, {
      props: { label: 'Filter by status', children: buttons },
    });
    expect(screen.getByRole('button', { name: 'Draft (2)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Review (0)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('is axe-clean', async () => {
    const { container } = render(IconToggleGroup, {
      props: { label: 'Filter by status', children: buttons },
    });
    await expectNoA11yViolations(container);
  });
});
