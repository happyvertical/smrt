// @vitest-environment jsdom
/**
 * Component coverage for UserMenu via the shared S11 harness (#1416).
 *
 * NOTE: axe is asserted on the closed state only. When open, the dropdown reuses
 * the wrapper's `id` (duplicate id) and points `aria-labelledby` at a
 * non-existent trigger id — pre-existing a11y bugs to fix under S12 (#1417).
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

  it('is axe-clean while collapsed', async () => {
    const { container } = render(UserMenu, {
      props: { user: { name: 'Ada Lovelace' } },
    });
    await expectNoA11yViolations(container);
  });
});
