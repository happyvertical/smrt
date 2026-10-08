import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Harness from './shell-layout-harness.svelte';

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

describe('AdminShell root never scrolls', () => {
  it('clips its overflow so focus/scrollIntoView cannot shift the shell', () => {
    // `overflow: hidden` is still programmatically scrollable; only `clip` is
    // not. jsdom cannot lay out a grid, so assert the declared rule.
    const source = readFileSync(
      resolve(
        process.cwd(),
        'src/components/workspace/admin-shell/AdminShell.svelte',
      ),
      'utf8',
    );
    const rule = source.match(/\n {2}\.smrt-admin-shell \{[\s\S]*?\n {2}\}\n/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toMatch(/overflow:\s*clip;/);
  });

  it('renders the shell root', () => {
    render(Harness, {});
    expect(document.querySelector('.smrt-admin-shell')).not.toBeNull();
  });
});
