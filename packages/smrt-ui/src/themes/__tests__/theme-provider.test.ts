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

function mockMedia(active: string[]) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: active.some((q) => query.includes(q)),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('ThemeProvider premium features (#3869)', () => {
  beforeEach(() => {
    localStorage.clear();
    for (const a of [
      'data-theme',
      'data-color-scheme',
      'data-contrast',
      'data-density',
      'data-forced-colors',
      'data-smrt-theme-changing',
    ]) {
      document.documentElement.removeAttribute(a);
    }
  });

  const style = (c: HTMLElement) =>
    c.querySelector('.smrt-theme-root')?.getAttribute('style') ?? '';

  it('maps borderRadius to control radius tokens, emitting nothing for md', () => {
    mockMedia([]);
    const md = render(ThemeProvider, { props: { children: child() } });
    expect(style(md.container)).not.toContain('--smrt-control-radius');
    md.unmount();
    const lg = render(ThemeProvider, {
      props: { borderRadius: 'lg', children: child() },
    });
    expect(style(lg.container)).toContain(
      '--smrt-control-radius: var(--smrt-radius-lg)',
    );
    expect(style(lg.container)).toContain(
      '--smrt-control-radius-small: var(--smrt-radius-md)',
    );
  });

  it('persists and validates density and explicit contrast', async () => {
    mockMedia([]);
    localStorage.setItem(
      'smrt-theme',
      JSON.stringify({ density: 'touch', contrast: 'bogus' }),
    );
    const { container } = render(ThemeProvider, {
      props: { children: child() },
    });
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-density')).toBe(
        'touch',
      ),
    );
    expect(style(container)).toContain('--smrt-control-target-min');
    expect(document.documentElement.getAttribute('data-contrast')).toBe(
      'standard',
    );
  });

  it('emits the derived primary set with a matching on-primary', () => {
    mockMedia([]);
    const { container } = render(ThemeProvider, {
      props: { primaryColor: '#ffeb3b', children: child() },
    });
    const s = style(container);
    expect(s).toContain('--smrt-color-primary: #ffeb3b');
    expect(s).toContain('--smrt-color-on-primary: #000000');
    for (const t of [
      'primary-container',
      'on-primary-container',
      'inverse-primary',
    ]) {
      expect(s).toContain(`--smrt-color-${t}:`);
    }
    expect(s).toContain('--smrt-focus-ring-color');
    expect(s).toContain('--smrt-selection-background');
  });

  it('resolves contrast from media queries and the contrast prop', async () => {
    mockMedia(['prefers-contrast: more']);
    const more = render(ThemeProvider, { props: { children: child() } });
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-contrast')).toBe(
        'more',
      ),
    );
    expect(
      more.container
        .querySelector('.smrt-theme-root')
        ?.getAttribute('data-contrast'),
    ).toBe('more');
    more.unmount();

    const std = render(ThemeProvider, {
      props: { contrast: 'standard', children: child() },
    });
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-contrast')).toBe(
        'standard',
      ),
    );
    std.unmount();

    mockMedia(['forced-colors']);
    const forced = render(ThemeProvider, { props: { children: child() } });
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-contrast')).toBe(
        'forced',
      ),
    );
    expect(document.documentElement.hasAttribute('data-forced-colors')).toBe(
      true,
    );
    expect(
      forced.container
        .querySelector('.smrt-theme-root')
        ?.hasAttribute('data-forced-colors'),
    ).toBe(true);
  });

  it('appends the forced-colors tokens inline only while forced, ahead of overrides', async () => {
    mockMedia([]);
    const std = render(ThemeProvider, {
      props: { primaryColor: '#336699', children: child() },
    });
    expect(style(std.container)).not.toContain('--smrt-hairline-color');
    std.unmount();

    mockMedia(['forced-colors']);
    const forced = render(ThemeProvider, {
      props: {
        primaryColor: '#336699',
        overrides: { '--smrt-focus-ring-width': '5px' },
        children: child(),
      },
    });
    await waitFor(() =>
      expect(style(forced.container)).toContain(
        '--smrt-hairline-color: CanvasText',
      ),
    );
    const inline = style(forced.container);
    expect(inline).toContain('--smrt-glass-blur: 0px');
    // Whatever the primary override emits for the ring, Highlight comes last.
    expect(inline).toMatch(/--smrt-focus-ring-color: Highlight(;|$)/);
    expect(inline.lastIndexOf('--smrt-focus-ring-color')).toBe(
      inline.lastIndexOf('--smrt-focus-ring-color: Highlight'),
    );
    // An explicit override still wins over the forced default.
    expect(inline.lastIndexOf('--smrt-focus-ring-width: 5px')).toBeGreaterThan(
      inline.lastIndexOf('--smrt-focus-ring-width: 3px'),
    );
  });

  it('flags a scheme change after mount, never on first paint', async () => {
    mockMedia([]);
    const { container, rerender } = render(ThemeProvider, {
      props: { colorScheme: 'light', children: child() },
    });
    const root = container.querySelector('.smrt-theme-root') as HTMLElement;
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
        'light',
      ),
    );
    expect(root.hasAttribute('data-smrt-theme-changing')).toBe(false);
    await rerender({ colorScheme: 'dark' });
    await waitFor(() =>
      expect(root.hasAttribute('data-smrt-theme-changing')).toBe(true),
    );
    expect(
      document.documentElement.hasAttribute('data-smrt-theme-changing'),
    ).toBe(true);
    await waitFor(
      () => expect(root.hasAttribute('data-smrt-theme-changing')).toBe(false),
      { timeout: 2000 },
    );
  });

  it('skips the scheme flag under prefers-reduced-motion', async () => {
    mockMedia(['prefers-reduced-motion']);
    const { container, rerender } = render(ThemeProvider, {
      props: { colorScheme: 'light', children: child() },
    });
    const root = container.querySelector('.smrt-theme-root') as HTMLElement;
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
        'light',
      ),
    );
    await rerender({ colorScheme: 'dark' });
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
        'dark',
      ),
    );
    expect(root.hasAttribute('data-smrt-theme-changing')).toBe(false);
  });
});

describe('ThemeProvider updateConfig (#3873)', () => {
  it('keeps programmatic overrides and storageKey instead of re-syncing the props', async () => {
    mockSystemDark(false);
    const { default: Harness } = await import(
      './theme-update-config.fixture.svelte'
    );
    const { getByTestId } = render(Harness);

    await waitFor(() => {
      expect(JSON.parse(getByTestId('config').textContent ?? '{}')).toEqual({
        overrides: { '--smrt-color-primary': 'red' },
        storageKey: 'child-theme',
      });
    });
  });
});
