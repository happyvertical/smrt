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

  it('paints the surface by default and opts out via paintSurface=false', async () => {
    mockSystemDark(false);

    const { container, rerender } = render(ThemeProvider, {
      props: { children: child() },
    });
    const root = container.querySelector('.smrt-theme-root');
    expect(root).not.toHaveClass('no-paint');

    await rerender({ paintSurface: false, children: child() });
    expect(root).toHaveClass('no-paint');
  });

  it('ignores invalid persisted theme values instead of breaking hydration', async () => {
    localStorage.setItem(
      'smrt-theme',
      JSON.stringify({
        preset: 'not-a-theme',
        colorScheme: 'sepia',
        borderRadius: 'enormous',
      }),
    );
    mockSystemDark(false);

    render(ThemeProvider, {
      props: {
        preset: 'material',
        colorScheme: 'system',
        children: child(),
      },
    });

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe(
        'material',
      );
      expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
        'light',
      );
    });
  });

  it('renders no inline variable payload for built-in presets (static-first)', () => {
    mockSystemDark(false);
    const { container } = render(ThemeProvider, {
      props: { children: child() },
    });
    const root = container.querySelector('.smrt-theme-root');
    const style = root?.getAttribute('style') ?? '';

    // Built-in presets ship their full variable set as static stylesheets
    // selected by the data attributes — the wrapper carries no ~200-var style.
    expect(style).not.toContain('--smrt-color-background');
    expect(root).toHaveAttribute('data-theme');
    expect(root).toHaveAttribute('data-color-scheme');
  });

  it('applies only the explicit accent/overrides inline for built-in presets', () => {
    mockSystemDark(false);
    const { container } = render(ThemeProvider, {
      props: {
        primaryColor: '#123456',
        overrides: { '--smrt-color-tertiary': '#654321' },
        children: child(),
      },
    });
    const style =
      container.querySelector('.smrt-theme-root')?.getAttribute('style') ?? '';

    expect(style).toContain('--smrt-color-primary: #123456');
    expect(style).toContain('--smrt-color-tertiary: #654321');
    expect(style).not.toContain('--smrt-color-background');
  });

  it('keeps runtime variable generation for custom registered themes', async () => {
    const { createTheme, registerTheme } = await import('../create-theme.js');
    registerTheme(
      createTheme({
        id: 'provider-test-brand',
        name: 'Provider Test Brand',
        light: { primary: '#336699', background: '#fefefe' },
        dark: { primary: '#99ccff', background: '#101820' },
      }),
    );
    mockSystemDark(false);

    const { container } = render(ThemeProvider, {
      props: { preset: 'provider-test-brand', children: child() },
    });
    const style =
      container.querySelector('.smrt-theme-root')?.getAttribute('style') ?? '';

    // No static stylesheet can exist for a registered custom theme, so the
    // provider falls back to the legacy runtime-generated variable set.
    expect(style).toContain('--smrt-color-background: #fefefe');
  });

  it('opts a built-in preset back into runtime generation via inlineVariables', () => {
    mockSystemDark(false);
    const { container } = render(ThemeProvider, {
      props: { preset: 'material', inlineVariables: true, children: child() },
    });
    const style =
      container.querySelector('.smrt-theme-root')?.getAttribute('style') ?? '';

    expect(style).toContain('--smrt-color-background');
  });
});
