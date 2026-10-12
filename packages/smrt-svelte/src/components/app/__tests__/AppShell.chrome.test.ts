import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChromeHarness from './app-shell-chrome-harness.svelte';

beforeEach(() => {
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

describe('AppShell chrome', () => {
  it('renders the shell chrome by default', () => {
    render(ChromeHarness, {});
    expect(
      document.querySelector('[data-smrt-component="AdminShell"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain('page body');
  });

  it('renders only the children when chrome is false', () => {
    render(ChromeHarness, { chrome: false });
    expect(
      document.querySelector('[data-smrt-component="AdminShell"]'),
    ).toBeNull();
    expect(document.querySelector('nav')).toBeNull();
    expect(document.body.textContent).toContain('page body');
  });
});
