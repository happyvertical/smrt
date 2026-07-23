/**
 * Tests for the themeScript() pre-paint bootstrap generator. The generated
 * script must mirror ThemeProvider's persistence resolution so apps stop
 * hand-duplicating it in app.html.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { themeScript } from '../theme-script.js';

function mockSystemDark(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
  })) as unknown as typeof window.matchMedia;
}

function run(script: string) {
  // biome-ignore lint/security/noGlobalEval: the browser evals this inline bootstrap; testing that is the point
  (0, eval)(script);
}

describe('themeScript', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-color-scheme');
    document.documentElement.classList.remove('dark');
  });

  it('resolves system preference when nothing is stored', () => {
    mockSystemDark(true);
    run(themeScript({ preset: 'material' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe(
      'material',
    );
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'dark',
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('honours a stored scheme and preset over system and defaults', () => {
    mockSystemDark(true);
    localStorage.setItem(
      'smrt-theme',
      JSON.stringify({ preset: 'studio', colorScheme: 'light' }),
    );
    run(themeScript({ preset: 'material' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('studio');
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'light',
    );
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('uses the custom storageKey', () => {
    mockSystemDark(false);
    localStorage.setItem('my-theme', JSON.stringify({ colorScheme: 'dark' }));
    run(themeScript({ storageKey: 'my-theme' }));
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'dark',
    );
  });

  it('tolerates a raw (non-JSON) stored scheme', () => {
    mockSystemDark(false);
    localStorage.setItem('smrt-theme', 'dark');
    run(themeScript());
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'dark',
    );
  });
});
