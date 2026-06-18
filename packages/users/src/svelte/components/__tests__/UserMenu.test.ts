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
});
