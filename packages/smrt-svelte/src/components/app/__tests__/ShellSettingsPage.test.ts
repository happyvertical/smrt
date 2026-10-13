import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Harness from './settings-page-harness.svelte';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const page = () =>
  document.querySelector<HTMLElement>(
    '[data-smrt-component="ShellSettingsPage"]',
  ) as HTMLElement;
const part = (name: string) =>
  page().querySelector<HTMLElement>(`[data-smrt-part="${name}"]`);

describe('ShellSettingsPage', () => {
  it('renders Appearance, Account and Layout sections reusing the theme controls', () => {
    render(Harness, {});
    for (const name of ['appearance', 'account', 'layout']) {
      expect(part(name)).not.toBeNull();
    }
    expect(
      part('appearance')?.querySelector(
        '[data-smrt-component="ThemeSwitcher"]',
      ),
    ).not.toBeNull();
    expect(
      part('appearance')?.querySelector(
        '[data-smrt-component="ColorSchemeToggle"]',
      ),
    ).not.toBeNull();
  });

  it('shows the signed-in name and email from the Provider user', () => {
    render(Harness, {});
    expect(part('account')?.textContent).toContain('Ada Owner');
    expect(part('account')?.textContent).toContain('ada@example.com');
  });

  it('renders sign-out only when the host provides one', async () => {
    render(Harness, {});
    expect(screen.queryByText('Sign out')).toBeNull();
    cleanup();
    const onSignOut = vi.fn();
    render(Harness, { onSignOut });
    await fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledOnce();
    cleanup();
    render(Harness, { signOutHref: '/logout' });
    expect(
      screen.getByRole('link', { name: 'Sign out' }).getAttribute('href'),
    ).toBe('/logout');
  });

  it('awaits an async sign-out: busy while pending, no double submit', async () => {
    let resolve!: () => void;
    const onSignOut = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(Harness, { onSignOut });
    const button = screen.getByRole('button', { name: 'Sign out' });
    await fireEvent.click(button);
    await fireEvent.click(button);
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    resolve();
    await waitFor(() =>
      expect(button).not.toHaveAttribute('aria-busy', 'true'),
    );
  });

  it('shows an inline error in the Account section when sign-out rejects', async () => {
    const onSignOut = vi.fn().mockRejectedValue(new Error('nope'));
    render(Harness, { onSignOut });
    await fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't sign out. Try again.",
    );
    expect(part('account')?.contains(screen.getByRole('alert'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Sign out' })).not.toBeDisabled();
  });

  it('hides the keyboard shortcuts section when hotkeys and edge toggles are off', () => {
    render(Harness, {});
    expect(part('shortcuts')).toBeNull();
  });

  it('shows the keyboard shortcuts section when edge toggles are enabled', () => {
    render(Harness, { edgeToggles: true });
    expect(part('shortcuts')).not.toBeNull();
  });

  it('shows the shortcuts section when only hotkeys are enabled', () => {
    render(Harness, { hotkeys: true });
    expect(part('shortcuts')).not.toBeNull();
  });

  it('describes inline regions without collapse / expand wording and uses user-facing names', () => {
    render(Harness, {});
    const layout = part('layout') as HTMLElement;
    const rows = layout.querySelectorAll('[data-edge]');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.getAttribute('data-edge') === 'right') continue;
      expect(row.textContent).not.toMatch(/collapse|expand/i);
    }
    expect(layout.textContent).toContain('Left sidebar');
    expect(layout.textContent).toContain('Shown');
  });

  it('leaves regions that are not rendered out of the Layout rows', () => {
    // The harness has no footer or right-sidebar content, so those are skipped.
    render(Harness, {});
    const layout = part('layout') as HTMLElement;
    expect(layout.querySelector('[data-edge="left"]')).not.toBeNull();
    expect(layout.querySelector('[data-edge="top"]')).not.toBeNull();
    expect(layout.querySelector('[data-edge="bottom"]')).toBeNull();
    expect(layout.querySelector('[data-edge="right"]')).toBeNull();
  });

  it('keeps a region the user hid listed so Show can restore it', async () => {
    render(Harness, {});
    const layout = within(part('layout') as HTMLElement);
    await fireEvent.click(layout.getByRole('button', { name: 'Edit layout' }));
    // Editing renders every band, so the footer has a row.
    await waitFor(() =>
      expect(
        part('layout')?.querySelector('[data-edge="bottom"]'),
      ).not.toBeNull(),
    );
    await fireEvent.click(layout.getByRole('button', { name: 'Hide Footer' }));
    await fireEvent.click(
      layout.getByRole('button', { name: 'Editing layout' }),
    );
    await waitFor(() =>
      expect(
        layout.queryByRole('button', { name: 'Editing layout' }),
      ).toBeNull(),
    );
    // Not rendered (empty) yet hidden by the user: still listed.
    expect(
      part('layout')?.querySelector('[data-edge="bottom"]'),
    ).not.toBeNull();
    expect(
      layout.getByRole('button', { name: 'Show Footer' }),
    ).toBeInTheDocument();
  });

  it('offers collapse / expand only for drop-down regions', () => {
    render(Harness, { edgeToggles: true });
    expect(part('layout')?.textContent).toMatch(/Collapse|Expand/);
  });

  it('toggles layout editing and hides a region from the Layout section', async () => {
    render(Harness, {});
    const layout = within(part('layout') as HTMLElement);
    const edit = layout.getByRole('button', { name: 'Edit layout' });
    expect(edit.getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(edit);
    expect(
      layout
        .getByRole('button', { name: 'Editing layout' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    await fireEvent.click(layout.getByRole('button', { name: 'Hide Footer' }));
    expect(
      part('layout')?.querySelector('[data-edge="bottom"]')?.textContent,
    ).toContain('Hidden');
    await fireEvent.click(layout.getByRole('button', { name: 'Reset layout' }));
    expect(
      part('layout')?.querySelector('[data-edge="bottom"]')?.textContent,
    ).toContain('Shown');
  });

  it('omits the edit-layout toggle when the host did not opt in', () => {
    render(Harness, { layoutEditing: false });
    expect(
      within(part('layout') as HTMLElement).queryByRole('button', {
        name: 'Edit layout',
      }),
    ).toBeNull();
  });
});
