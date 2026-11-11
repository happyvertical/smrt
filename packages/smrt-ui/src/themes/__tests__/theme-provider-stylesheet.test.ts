import { render } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const environment = vi.hoisted(() => ({ dev: true }));
vi.mock('esm-env', () => ({
  get DEV() {
    return environment.dev;
  },
}));

import { createTheme, registerTheme } from '../create-theme.js';
import ThemeProvider from '../ThemeProvider.svelte';

const children = createRawSnippet(() => ({
  render: () => '<span>child</span>',
}));

describe('ThemeProvider missing preset stylesheet', () => {
  beforeEach(() => {
    environment.dev = true;
    localStorage.clear();
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('warns with the persisted preset import once per mount, without adding CSS', async () => {
    localStorage.setItem('smrt-theme', JSON.stringify({ preset: 'studio' }));
    const view = render(ThemeProvider, { props: { children } });
    await tick();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "import '@happyvertical/smrt-ui/themes/styles/studio.css'",
      ),
    );
    expect(view.container.querySelector('style')).toBeNull();
    expect(
      view.container.firstElementChild?.getAttribute('style') ?? '',
    ).not.toContain('--smrt-color-background');
    await view.rerender({ colorScheme: 'dark' });
    await tick();
    expect(console.warn).toHaveBeenCalledTimes(1);
    view.unmount();
    render(ThemeProvider, { props: { children, persist: false } });
    await tick();
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('does not warn when the required token resolves on the root', async () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => ' white ',
    } as unknown as CSSStyleDeclaration);
    render(ThemeProvider, { props: { children, persist: false } });
    await tick();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('does not let an accent override hide the missing stylesheet', async () => {
    render(ThemeProvider, {
      props: { children, primaryColor: 'red', persist: false },
    });
    await tick();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('skips built-ins with inlineVariables and custom registered themes', async () => {
    const computed = vi.spyOn(window, 'getComputedStyle');
    render(ThemeProvider, {
      props: { children, inlineVariables: true, persist: false },
    });
    registerTheme(
      createTheme({
        id: 'stylesheet-test-custom',
        name: 'Test',
        light: { primary: '#336699' },
      }),
    );
    render(ThemeProvider, {
      props: { children, preset: 'stylesheet-test-custom', persist: false },
    });
    await tick();
    expect(console.warn).not.toHaveBeenCalled();
    expect(computed).not.toHaveBeenCalled();
  });

  it('does no computed-style work in production', async () => {
    environment.dev = false;
    const computed = vi.spyOn(window, 'getComputedStyle');
    render(ThemeProvider, { props: { children, persist: false } });
    await tick();
    expect(console.warn).not.toHaveBeenCalled();
    expect(computed).not.toHaveBeenCalled();
  });
});
