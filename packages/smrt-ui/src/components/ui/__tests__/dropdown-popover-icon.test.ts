/**
 * Dropdown menu items take an icon, and Dropdown and Popover each offer an
 * icon-only trigger look (a borderless 44px round button in the surrounding
 * colour), so an app does not restyle `.dropdown__trigger` / `.popover__trigger`.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Dropdown from '../Dropdown.svelte';
import Popover from '../Popover.svelte';

const glyph = createRawSnippet(() => ({
  render: () =>
    '<svg data-testid="glyph" viewBox="0 0 24 24" width="18" height="18"></svg>',
}));
const body = createRawSnippet(() => ({ render: () => '<p>Details</p>' }));

describe('Dropdown icons', () => {
  it('shows an item icon beside the label and hides it from assistive technology', async () => {
    render(Dropdown, {
      props: {
        label: 'Actions',
        items: [
          { id: 'edit', label: 'Edit', icon: glyph },
          { id: 'plain', label: 'Plain' },
        ],
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const edit = screen.getByRole('menuitem', { name: 'Edit' });
    const icon = edit.querySelector('.dropdown__item-icon');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon?.querySelector('svg')).not.toBeNull();
    expect(
      screen
        .getByRole('menuitem', { name: 'Plain' })
        .querySelector('.dropdown__item-icon'),
    ).toBeNull();
  });

  it('is an icon-only 44px trigger named by triggerLabel', async () => {
    const { container } = render(Dropdown, {
      props: {
        variant: 'icon',
        triggerLabel: 'Actions for July 14 Council',
        trigger: glyph,
        items: [{ id: 'edit', label: 'Edit', icon: glyph }],
      },
    });
    const trigger = screen.getByRole('button', {
      name: 'Actions for July 14 Council',
    });
    expect(trigger).toHaveClass('dropdown__trigger--icon');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(trigger);
    await expectNoA11yViolations(container);
  });

  it('keeps the bordered button look by default', () => {
    render(Dropdown, {
      props: { label: 'Actions', items: [{ id: 'a', label: 'A' }] },
    });
    expect(screen.getByRole('button', { name: 'Actions' })).not.toHaveClass(
      'dropdown__trigger--icon',
    );
  });
});

describe('Popover icon variant', () => {
  it('renders the icon trigger and opens its panel', async () => {
    render(Popover, {
      props: {
        label: 'Issues',
        triggerLabel: '2 issues',
        variant: 'icon',
        trigger: glyph,
        children: body,
      },
    });
    const trigger = screen.getByRole('button', { name: '2 issues' });
    expect(trigger).toHaveClass('popover__trigger--icon');
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Issues' })).toHaveTextContent(
      'Details',
    );
  });

  it('keeps the bordered button look by default', () => {
    render(Popover, { props: { label: 'Filters', children: body } });
    expect(screen.getByRole('button', { name: 'Filters' })).not.toHaveClass(
      'popover__trigger--icon',
    );
  });
});
