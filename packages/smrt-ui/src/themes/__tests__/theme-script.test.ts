/**
 * Tests for the themeScript() pre-paint bootstrap generator. The generated
 * script must mirror ThemeProvider's persistence resolution so apps stop
 * hand-duplicating it in app.html.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTheme, registerTheme } from '../create-theme.js';
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
    vi.restoreAllMocks();
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

  it('ships no inline variable payload — static CSS owns the values', () => {
    mockSystemDark(false);
    const script = themeScript({ preset: 'studio' });
    // The pre-paint script only stamps attributes; variable values come from
    // the static per-preset stylesheets selected by those attributes.
    expect(script).not.toContain('--smrt-');
    expect(script).not.toContain('bootstrap');
    expect(script.length).toBeLessThan(1024);

    run(script);
    for (const property of Array.from(document.documentElement.style)) {
      expect(property.startsWith('--smrt-')).toBe(false);
    }
  });

  it('uses the custom storageKey', () => {
    mockSystemDark(false);
    localStorage.setItem('my-theme', JSON.stringify({ colorScheme: 'dark' }));
    run(themeScript({ storageKey: 'my-theme' }));
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'dark',
    );
  });

  it('does not read stored preferences when persistence is disabled', () => {
    mockSystemDark(false);
    localStorage.setItem(
      'smrt-theme',
      JSON.stringify({ preset: 'studio', colorScheme: 'dark' }),
    );
    run(
      themeScript({
        persist: false,
        preset: 'material',
        defaultColorScheme: 'light',
      }),
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe(
      'material',
    );
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'light',
    );
  });

  it('ignores a raw (non-JSON) stored value like ThemeProvider', () => {
    mockSystemDark(true);
    localStorage.setItem('smrt-theme', 'light');
    run(themeScript());
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'dark',
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('ignores invalid persisted enum values', () => {
    mockSystemDark(false);
    localStorage.setItem(
      'smrt-theme',
      JSON.stringify({
        preset: 'not-a-theme',
        colorScheme: 'sepia',
      }),
    );
    run(themeScript({ preset: 'material', defaultColorScheme: 'light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe(
      'material',
    );
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'light',
    );
  });

  it('stamps a persisted registered custom theme pre-paint', () => {
    const brandTheme = createTheme({
      id: 'bootstrap-test-brand',
      name: 'Bootstrap Test Brand',
      light: { primary: '#336699', background: '#fefefe' },
      dark: { primary: '#99ccff', background: '#101820' },
    });
    registerTheme(brandTheme);
    mockSystemDark(false);
    localStorage.setItem(
      'smrt-theme',
      JSON.stringify({
        preset: 'bootstrap-test-brand',
        colorScheme: 'dark',
      }),
    );

    run(themeScript());

    expect(document.documentElement.getAttribute('data-theme')).toBe(
      'bootstrap-test-brand',
    );
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'dark',
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('still applies the fallback when localStorage access throws', () => {
    mockSystemDark(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    run(themeScript({ preset: 'studio' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('studio');
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe(
      'dark',
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('escapes executable inline-script terminators and separators', () => {
    const script = themeScript({
      storageKey: '</script><script>alert(1)</script>\u2028\u2029',
    });

    expect(script.toLowerCase()).not.toContain('</script');
    expect(script).not.toContain('\u2028');
    expect(script).not.toContain('\u2029');
    expect(script).toContain('\\u003c/script>');
  });
});
