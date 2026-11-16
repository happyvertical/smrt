/**
 * #5025: a nested ThemeProvider that asks for `system` follows its parent
 * provider (the host application's choice), not the OS. An explicit scheme on
 * the nested provider still wins, and a root provider is unchanged.
 */
import { render, waitFor } from '@testing-library/svelte';
import { createRawSnippet, flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeProvider from '../ThemeProvider.svelte';
import Fixture from './theme-provider-follow-parent.fixture.svelte';

function mockSystemDark(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-color-scheme') ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function wrappers(container: HTMLElement) {
  const roots = container.querySelectorAll<HTMLElement>(
    '[data-smrt-component="ThemeProvider"]',
  );
  return { host: roots[0], inner: roots[1] };
}

beforeEach(() => {
  localStorage.clear();
  for (const a of ['data-theme', 'data-color-scheme']) {
    document.documentElement.removeAttribute(a);
  }
});

describe('nested ThemeProvider follows its parent (#5025)', () => {
  it.each([
    { os: true, host: 'light', expected: 'light' },
    { os: false, host: 'dark', expected: 'dark' },
  ] as const)('OS dark=$os, host stored $host: nested resolves $expected', async ({
    os,
    host,
    expected,
  }) => {
    mockSystemDark(os);
    localStorage.setItem(
      'host-theme',
      JSON.stringify({ preset: 'smrt', colorScheme: host }),
    );
    const { container } = render(Fixture);
    await waitFor(() =>
      expect(wrappers(container).inner.dataset.colorScheme).toBe(expected),
    );
    const { host: hostEl, inner } = wrappers(container);
    expect(hostEl.dataset.colorScheme).toBe(expected);
    expect(inner.classList.contains('smrt-theme-provider__dark')).toBe(
      expected === 'dark',
    );
    expect(inner.dataset.theme).toBe('glass');
    expect(document.documentElement.dataset.colorScheme).toBe(expected);
  });

  it('follows a live toggle of the host', async () => {
    mockSystemDark(true);
    localStorage.setItem(
      'host-theme',
      JSON.stringify({ preset: 'smrt', colorScheme: 'light' }),
    );
    let hostContext:
      | { setColorScheme: (s: 'light' | 'dark') => void }
      | undefined;
    const { container } = render(Fixture, {
      props: { onhost: (c) => (hostContext = c) },
    });
    await waitFor(() =>
      expect(wrappers(container).inner.dataset.colorScheme).toBe('light'),
    );
    hostContext?.setColorScheme('dark');
    flushSync();
    await waitFor(() =>
      expect(wrappers(container).inner.dataset.colorScheme).toBe('dark'),
    );
    hostContext?.setColorScheme('light');
    await waitFor(() =>
      expect(wrappers(container).inner.dataset.colorScheme).toBe('light'),
    );
  });

  it('an explicit nested scheme wins over the host', async () => {
    mockSystemDark(false);
    localStorage.setItem(
      'host-theme',
      JSON.stringify({ preset: 'smrt', colorScheme: 'light' }),
    );
    const { container } = render(Fixture, { props: { innerScheme: 'dark' } });
    await waitFor(() =>
      expect(wrappers(container).host.dataset.colorScheme).toBe('light'),
    );
    expect(wrappers(container).inner.dataset.colorScheme).toBe('dark');
  });

  it('ignores a stored scheme in its own key when it asked for system, but still loads the stored preset', async () => {
    mockSystemDark(false);
    localStorage.setItem(
      'host-theme',
      JSON.stringify({ preset: 'smrt', colorScheme: 'dark' }),
    );
    localStorage.setItem(
      'smrt-theme',
      JSON.stringify({ preset: 'material', colorScheme: 'light' }),
    );
    const { container } = render(Fixture);
    await waitFor(() =>
      expect(wrappers(container).inner.dataset.theme).toBe('material'),
    );
    expect(wrappers(container).inner.dataset.colorScheme).toBe('dark');
    // The nested provider never touches the host's key.
    expect(
      JSON.parse(localStorage.getItem('host-theme') ?? '{}'),
    ).toMatchObject({
      colorScheme: 'dark',
    });
  });

  it('honours a stored scheme when the nested provider asked for an explicit one', async () => {
    mockSystemDark(false);
    localStorage.setItem(
      'host-theme',
      JSON.stringify({ preset: 'smrt', colorScheme: 'dark' }),
    );
    localStorage.setItem(
      'smrt-theme',
      JSON.stringify({ colorScheme: 'light' }),
    );
    const { container } = render(Fixture, { props: { innerScheme: 'dark' } });
    await waitFor(() =>
      expect(wrappers(container).inner.dataset.colorScheme).toBe('light'),
    );
  });
});

describe('root ThemeProvider is unchanged', () => {
  it('system follows the OS and a stored scheme is honoured', async () => {
    mockSystemDark(true);
    const snippet = createRawSnippet(() => ({ render: () => '<i></i>' }));
    const { container, unmount } = render(ThemeProvider, {
      props: { children: snippet },
    });
    await waitFor(() =>
      expect(wrappers(container).host.dataset.colorScheme).toBe('dark'),
    );
    unmount();
    localStorage.setItem(
      'smrt-theme',
      JSON.stringify({ colorScheme: 'light' }),
    );
    const again = render(ThemeProvider, { props: { children: snippet } });
    await waitFor(() =>
      expect(wrappers(again.container).host.dataset.colorScheme).toBe('light'),
    );
  });
});
