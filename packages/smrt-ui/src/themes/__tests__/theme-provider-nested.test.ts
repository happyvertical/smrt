/**
 * #4485: only a root ThemeProvider owns the document attributes. A nested one
 * (the planner AppShell's, for example) themes its own wrapper and must never
 * retheme the host page's <html>.
 */
import { render, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeProvider from '../ThemeProvider.svelte';
import Nested from './theme-provider-nested.fixture.svelte';

function child() {
  return createRawSnippet(() => ({ render: () => '<span>child</span>' }));
}

const DOC_ATTRS = [
  'data-theme',
  'data-color-scheme',
  'data-contrast',
  'data-density',
  'data-forced-colors',
  'data-smrt-theme-changing',
];

beforeEach(() => {
  localStorage.clear();
  const html = document.documentElement;
  for (const attr of DOC_ATTRS) html.removeAttribute(attr);
  html.classList.remove('dark');
  html.style.colorScheme = '';
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

describe('ThemeProvider document scope (#4485)', () => {
  it('a root provider still stamps the document element', async () => {
    render(ThemeProvider, {
      props: {
        preset: 'smrt',
        colorScheme: 'dark',
        density: 'touch',
        persist: false,
        children: child(),
      },
    });
    const html = document.documentElement;
    await waitFor(() => expect(html.dataset.theme).toBe('smrt'));
    expect(html.dataset.colorScheme).toBe('dark');
    expect(html.classList.contains('dark')).toBe(true);
    expect(html.style.colorScheme).toBe('dark');
    expect(html.dataset.density).toBe('touch');
    expect(html.dataset.contrast).toBe('standard');
  });

  it('a nested provider themes its own wrapper and leaves the document to the root', async () => {
    const { container } = render(Nested);
    const html = document.documentElement;
    await waitFor(() => expect(html.dataset.theme).toBe('smrt'));

    const roots = container.querySelectorAll<HTMLElement>('.smrt-theme-root');
    expect(roots).toHaveLength(2);
    const inner = roots[1];
    expect(inner.dataset.theme).toBe('material');
    expect(inner.dataset.colorScheme).toBe('light');
    expect(inner.dataset.density).toBe('touch');
    expect(inner.dataset.contrast).toBe('standard');
    // Document still carries the root provider's values, not the nested one's.
    expect(html.dataset.theme).toBe('smrt');
    expect(html.dataset.colorScheme).toBe('dark');
    expect(html.classList.contains('dark')).toBe(true);
    expect(html.dataset.density).toBeUndefined();
  });

  it('scope="document" on a nested provider opts back in, and scope="local" on a root opts out', async () => {
    const { default: Explicit } = await import(
      './theme-provider-nested-explicit.fixture.svelte'
    );
    render(Explicit);
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe('material'),
    );
  });
});
