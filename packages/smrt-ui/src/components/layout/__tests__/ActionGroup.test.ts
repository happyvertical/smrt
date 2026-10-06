import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import ActionGroup from '../ActionGroup.svelte';

const actions = createRawSnippet(() => ({
  render: () =>
    '<button type="button">Add</button><a href="/items">View all</a>',
}));

describe('ActionGroup', () => {
  it('uses a compact, start-aligned row by default', () => {
    const { container } = render(ActionGroup, { props: { children: actions } });
    expect(container.firstElementChild).toHaveClass(
      'action-group',
      'gap-sm',
      'justify-start',
    );
  });

  it('maps spacing and alignment options', () => {
    const { container } = render(ActionGroup, {
      props: { gap: 'md', justify: 'end', children: actions },
    });
    expect(container.firstElementChild).toHaveClass('gap-md', 'justify-end');
  });

  it('forwards native attributes and consumer classes', () => {
    render(ActionGroup, {
      props: {
        class: 'card-actions',
        role: 'group',
        'aria-label': 'Project actions',
        children: actions,
      },
    });
    expect(screen.getByRole('group', { name: 'Project actions' })).toHaveClass(
      'action-group',
      'card-actions',
    );
  });

  it('is axe-clean with mixed button and link actions', async () => {
    const { container } = render(ActionGroup, {
      props: {
        role: 'group',
        'aria-label': 'Actions',
        children: actions,
      },
    });
    await expectNoA11yViolations(container);
  });
});
