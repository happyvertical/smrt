import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import WorkspaceAccountMenu from '../admin-shell/WorkspaceAccountMenu.svelte';

const tenants = [
  { id: 'tenant-a', label: 'Acme', roleLabel: 'Owner' },
  { id: 'tenant-b', label: 'Beta', roleLabel: 'Member' },
];

describe('WorkspaceAccountMenu', () => {
  it('exposes typed touch density without changing account actions', () => {
    const { container } = render(WorkspaceAccountMenu, {
      props: { userName: 'Dana', density: 'touch', onSignOut: vi.fn() },
    });
    expect(
      container.querySelector('.smrt-workspace-account-menu'),
    ).toHaveAttribute('data-density', 'touch');
  });

  it('keeps the full account name accessible with a compact rail trigger', () => {
    const { container } = render(WorkspaceAccountMenu, {
      props: {
        userName: 'Ada Lovelace',
        userLabel: 'ada@example.com',
        tenantLabel: 'Acme',
        roleLabel: 'Owner',
        compact: true,
        onSignOut: vi.fn(),
      },
    });

    expect(
      container.querySelector('.smrt-workspace-account-menu'),
    ).toHaveAttribute('data-compact');
    expect(
      screen.getByRole('button', {
        name: 'Open account menu ada@example.com · Acme · Owner',
      }),
    ).toBeVisible();
  });
  it('switches tenant and signs out through app-owned callbacks', async () => {
    const user = userEvent.setup();
    const onTenantSelect = vi.fn();
    const onSignOut = vi.fn();

    render(WorkspaceAccountMenu, {
      props: {
        userName: 'Ada Lovelace',
        userLabel: 'ada@example.com',
        tenantLabel: 'Acme',
        roleLabel: 'Owner',
        currentTenantId: 'tenant-a',
        tenants,
        onTenantSelect,
        onSignOut,
      },
    });

    const trigger = screen.getByRole('button', {
      name: /Open account menu ada@example.com Acme · Owner/,
    });
    await user.click(trigger);

    expect(
      screen.getByRole('menuitem', { name: 'Acme — current — Owner' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('menuitem', { name: 'Beta — Member' }));
    expect(onTenantSelect).toHaveBeenCalledWith('tenant-b');

    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it('keeps tenant switching out of the menu when only one tenant is available', async () => {
    const user = userEvent.setup();

    render(WorkspaceAccountMenu, {
      props: {
        userName: 'Ada Lovelace',
        userLabel: 'ada@example.com',
        tenantLabel: 'Acme',
        roleLabel: 'Owner',
        currentTenantId: 'tenant-a',
        tenants: tenants.slice(0, 1),
        onTenantSelect: vi.fn(),
        onSignOut: vi.fn(),
      },
    });

    const trigger = screen.getByRole('button', {
      name: /Open account menu ada@example.com Acme · Owner/,
    });
    await user.click(trigger);

    expect(screen.queryByRole('menuitem', { name: /Acme/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  });

  it('shows the email, links to Settings and signs out through a link', async () => {
    const user = userEvent.setup();
    render(WorkspaceAccountMenu, {
      props: {
        userName: 'Ada Lovelace',
        email: 'ada@example.com',
        settingsHref: '/settings',
        signOutHref: '/logout',
      },
    });
    await user.click(screen.getByRole('button', { name: /Open account menu/ }));
    expect(screen.getByText('ada@example.com')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveAttribute(
      'href',
      '/logout',
    );
  });

  it('moves focus into the menu, closes on Escape and refocuses the trigger', async () => {
    const user = userEvent.setup();
    render(WorkspaceAccountMenu, {
      props: { userName: 'Ada', settingsHref: '/settings', onSignOut: vi.fn() },
    });
    const trigger = screen.getByRole('button', { name: /Open account menu/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('is axe-clean', async () => {
    const { container } = render(WorkspaceAccountMenu, {
      props: {
        userName: 'Ada Lovelace',
        userLabel: 'ada@example.com',
        tenantLabel: 'Acme',
        currentTenantId: 'tenant-a',
        tenants,
        onTenantSelect: vi.fn(),
        onSignOut: vi.fn(),
      },
    });

    await expectNoA11yViolations(container);
  });

  it('is axe-clean while open', async () => {
    const user = userEvent.setup();
    const { container } = render(WorkspaceAccountMenu, {
      props: {
        userName: 'Ada Lovelace',
        email: 'ada@example.com',
        settingsHref: '/settings',
        onSignOut: vi.fn(),
      },
    });
    await user.click(screen.getByRole('button', { name: /Open account menu/ }));
    await expectNoA11yViolations(container);
  });

  describe('async sign-out', () => {
    const open = async (onSignOut: () => void | Promise<void>) => {
      const user = userEvent.setup();
      render(WorkspaceAccountMenu, { props: { userName: 'Ada', onSignOut } });
      await user.click(
        screen.getByRole('button', { name: /Open account menu/ }),
      );
      return user;
    };

    it('shows a busy, disabled item while pending and closes on success', async () => {
      let resolve!: () => void;
      const onSignOut = vi.fn(() => new Promise<void>((r) => (resolve = r)));
      const user = await open(onSignOut);
      await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
      const item = screen.getByRole('menuitem', { name: 'Sign out' });
      expect(item).toHaveAttribute('aria-busy', 'true');
      expect(item).toBeDisabled();
      resolve();
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      expect(onSignOut).toHaveBeenCalledOnce();
    });

    it('ignores a second activation while pending', async () => {
      const onSignOut = vi.fn(() => new Promise<void>(() => {}));
      const user = await open(onSignOut);
      const item = screen.getByRole('menuitem', { name: 'Sign out' });
      await user.dblClick(item);
      await user.click(item);
      expect(onSignOut).toHaveBeenCalledOnce();
    });

    it('stays open with an inline error on rejection and can retry', async () => {
      const onSignOut = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce(undefined);
      const user = await open(onSignOut);
      await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Couldn't sign out. Try again.",
      );
      const item = screen.getByRole('menuitem', { name: 'Sign out' });
      expect(item).not.toBeDisabled();
      expect(item).not.toHaveAttribute('aria-busy');
      await user.click(item);
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      expect(onSignOut).toHaveBeenCalledTimes(2);
    });
  });
});
