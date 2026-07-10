import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import WorkspaceAccountMenu from '../admin-shell/WorkspaceAccountMenu.svelte';

const tenants = [
  { id: 'tenant-a', label: 'Acme', roleLabel: 'Owner' },
  { id: 'tenant-b', label: 'Beta', roleLabel: 'Member' },
];

describe('WorkspaceAccountMenu', () => {
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
      name: /Open account menu Acme · ada@example.com/,
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
});
