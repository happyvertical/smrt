/**
 * Regression tests for ThemeProvider persistence behavior.
 *
 * Bug: the prop-sync `$effect`s re-asserted the `colorScheme`/`preset` props on
 * every mount, clobbering the persisted localStorage preference loaded in
 * `onMount` — a toggled light/dark choice snapped back to the prop (typically
 * "system") on reload. Fixed by only syncing props on actual prop changes.
 */
import { render, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeProvider from '../ThemeProvider.svelte';

function child() {
  return createRawSnippet(() => ({ render: () => '<span>child</span>' }));
}

function mockSystemDark(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('ThemeProvider persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-color-scheme');
  });

  it('keeps the persisted color scheme instead of clobbering it with the prop', async () => {
    localStorage.setItem(
      'smrt-theme',
      JSON.stringify({ colorScheme: 'light' }),
    );
    mockSystemDark(true); // system is dark; stored choice is light

    render(ThemeProvider, {
      props: { colorScheme: 'system', children: child() },
    });

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
        'light',
      );
    });
    // The stored preference must survive too (not rewritten to the prop value)
    expect(JSON.parse(localStorage.getItem('smrt-theme')!)).toMatchObject({
      colorScheme: 'light',
    });
  });

  it('falls back to the system scheme when nothing is persisted', async () => {
    mockSystemDark(true);

    render(ThemeProvider, {
      props: { colorScheme: 'system', children: child() },
    });

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
        'dark',
      );
    });
  });

  it('still applies prop changes after mount', async () => {
    mockSystemDark(false);

    const { rerender } = render(ThemeProvider, {
      props: { colorScheme: 'system', children: child() },
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
        'light',
      );
    });

    await rerender({ colorScheme: 'dark', children: child() });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
        'dark',
      );
    });
  });
});
