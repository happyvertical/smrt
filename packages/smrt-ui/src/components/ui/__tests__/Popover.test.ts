import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Popover from '../Popover.svelte';

const icon = createRawSnippet(() => ({
  render: () => '<svg viewBox="0 0 24 24" width="18" height="18"></svg>',
}));
const body = createRawSnippet(() => ({
  render: () => '<p>No main picture</p>',
}));

describe('Popover', () => {
  it('names an icon-only trigger with triggerLabel and opens its panel', async () => {
    render(Popover, {
      props: {
        label: 'Issues',
        triggerLabel: '3 issues',
        trigger: icon,
        children: body,
      },
    });
    const trigger = screen.getByRole('button', { name: '3 issues' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Issues' })).toHaveTextContent(
      'No main picture',
    );
  });

  it('is named by its visible content when there is no triggerLabel', () => {
    render(Popover, { props: { label: 'Filters', children: body } });
    expect(screen.getByRole('button', { name: 'Filters' })).not.toHaveAttribute(
      'aria-label',
    );
  });

  it('is axe-clean with an icon-only trigger', async () => {
    const { container } = render(Popover, {
      props: {
        label: 'Issues',
        triggerLabel: '3 issues',
        trigger: icon,
        children: body,
      },
    });
    await expectNoA11yViolations(container);
  });
});
