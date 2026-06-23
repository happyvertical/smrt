/**
 * Component test for RoleSelector (#1586 remediation, epic #1354).
 *
 * RoleSelector is a single-select listbox: a trigger button (`aria-haspopup`/
 * `aria-expanded`) opens a `role="listbox"` of `role="option"` buttons. This
 * suite covers the keyboard support added to match the WAI-ARIA listbox pattern
 * (mirroring `ui/Dropdown.svelte`): open on Enter/ArrowDown, focus-into-list,
 * Arrow/Home/End roving focus, Enter to select, and Escape to close + refocus
 * the trigger. Axe-cleanliness is asserted for both open and closed states.
 */

import type { Role } from '@happyvertical/smrt-types';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import RoleSelector from '../RoleSelector.svelte';

function role(id: string, name: string, isSystem = false): Role {
  return {
    id,
    slug: id,
    created_at: null,
    updated_at: null,
    tenantId: null,
    name,
    description: `${name} role`,
    isSystem,
  };
}

const ROLES: Role[] = [
  role('admin', 'Admin', true),
  role('editor', 'Editor'),
  role('viewer', 'Viewer'),
];

describe('RoleSelector', () => {
  it('exposes a collapsed listbox trigger by default', () => {
    render(RoleSelector, { props: { roles: ROLES, onchange: vi.fn() } });
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the placeholder when no role is selected', () => {
    render(RoleSelector, {
      props: { roles: ROLES, onchange: vi.fn(), placeholder: 'Pick one' },
    });
    expect(screen.getByText('Pick one')).toBeInTheDocument();
  });

  it('opens via click and exposes the options as a listbox', async () => {
    render(RoleSelector, { props: { roles: ROLES, onchange: vi.fn() } });
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('opens on Enter and moves focus onto the first option', async () => {
    render(RoleSelector, { props: { roles: ROLES, onchange: vi.fn() } });
    screen.getByRole('button').focus();
    await userEvent.keyboard('{Enter}');
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveFocus();
  });

  it('opens on ArrowDown and focuses the already-selected option', async () => {
    render(RoleSelector, {
      props: { roles: ROLES, value: 'viewer', onchange: vi.fn() },
    });
    screen.getByRole('button').focus();
    await userEvent.keyboard('{ArrowDown}');
    const viewer = screen.getByRole('option', { name: /Viewer/ });
    expect(viewer).toHaveFocus();
  });

  it('roves focus with ArrowDown/ArrowUp and wraps at the ends', async () => {
    render(RoleSelector, { props: { roles: ROLES, onchange: vi.fn() } });
    screen.getByRole('button').focus();
    await userEvent.keyboard('{Enter}'); // focuses option 0 (Admin)
    const options = screen.getAllByRole('option');

    await userEvent.keyboard('{ArrowDown}');
    expect(options[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(options[2]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}'); // wraps to first
    expect(options[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}'); // wraps to last
    expect(options[2]).toHaveFocus();
  });

  it('jumps to the first/last option with Home/End', async () => {
    render(RoleSelector, { props: { roles: ROLES, onchange: vi.fn() } });
    screen.getByRole('button').focus();
    await userEvent.keyboard('{Enter}');
    const options = screen.getAllByRole('option');

    await userEvent.keyboard('{End}');
    expect(options[2]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(options[0]).toHaveFocus();
  });

  it('selects the focused option with Enter and fires onchange', async () => {
    const onchange = vi.fn();
    render(RoleSelector, { props: { roles: ROLES, onchange } });
    screen.getByRole('button').focus();
    await userEvent.keyboard('{Enter}'); // open, focus Admin
    await userEvent.keyboard('{ArrowDown}'); // focus Editor
    await userEvent.keyboard('{Enter}'); // select Editor
    expect(onchange).toHaveBeenCalledWith('editor');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    render(RoleSelector, { props: { roles: ROLES, onchange: vi.fn() } });
    const trigger = screen.getByRole('button');
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('does not open when disabled', async () => {
    render(RoleSelector, {
      props: { roles: ROLES, onchange: vi.fn(), disabled: true },
    });
    const trigger = screen.getByRole('button');
    await userEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('is axe-clean when closed', async () => {
    const { container } = render(RoleSelector, {
      props: { roles: ROLES, value: 'admin', onchange: vi.fn() },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean when open', async () => {
    const { container } = render(RoleSelector, {
      props: { roles: ROLES, onchange: vi.fn(), showDescription: true },
    });
    await userEvent.click(screen.getByRole('button'));
    await expectNoA11yViolations(container);
  });
});
