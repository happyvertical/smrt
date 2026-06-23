// @vitest-environment jsdom
/**
 * Component coverage for UserMenu via the shared S11 harness (#1416), plus the
 * S12 a11y remediation (#1417): the open dropdown now has its own id (no longer
 * duplicating the wrapper) and `aria-labelledby` resolves to the trigger, so axe
 * is asserted on both the collapsed and open states.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import UserMenu from '../UserMenu.svelte';

describe('UserMenu', () => {
  it('renders a collapsed trigger labelled with the display name', () => {
    render(UserMenu, { props: { user: { name: 'Ada Lovelace' } } });
    const trigger = screen.getByRole('button', { name: 'User menu' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the menu with profile/settings/sign-out items on click', async () => {
    render(UserMenu, {
      props: { user: { name: 'Ada Lovelace', email: 'ada@example.com' } },
    });
    await userEvent.click(screen.getByRole('button', { name: 'User menu' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Profile' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Settings' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Sign out' }),
    ).toBeInTheDocument();
  });

  it('is axe-clean while collapsed and when open', async () => {
    const { container } = render(UserMenu, {
      props: { user: { name: 'Ada Lovelace', email: 'ada@example.com' } },
    });
    await expectNoA11yViolations(container);
    await userEvent.click(screen.getByRole('button', { name: 'User menu' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  // Regression for #1399 blocker #1: the menu items were keyboard-unreachable
  // (role="menu" with no roving tabindex / arrow navigation). These assert the
  // WAI-ARIA menu-button keyboard contract end to end.
  const kbProps = {
    user: { name: 'Ada Lovelace', email: 'ada@example.com' },
  };

  it('opens from the trigger and focuses the first item on ArrowDown', async () => {
    render(UserMenu, { props: kbProps });
    screen.getByRole('button', { name: 'User menu' }).focus();
    await userEvent.keyboard('{ArrowDown}');

    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(3);
    expect(document.activeElement).toBe(items[0]);
  });

  it('moves roving focus with ArrowDown/ArrowUp and wraps at the ends', async () => {
    render(UserMenu, { props: kbProps });
    screen.getByRole('button', { name: 'User menu' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    const items = screen.getAllByRole('menuitem');

    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);

    // From the first item, ArrowUp wraps to the last.
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('jumps to the last item with End and the first with Home', async () => {
    render(UserMenu, { props: kbProps });
    screen.getByRole('button', { name: 'User menu' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    const items = screen.getAllByRole('menuitem');

    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(items[items.length - 1]);

    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(items[0]);
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    render(UserMenu, { props: kbProps });
    const trigger = screen.getByRole('button', { name: 'User menu' });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.queryByRole('menu')).not.toBeNull();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
