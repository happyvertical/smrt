/**
 * Cascade-layer contract (#3823): ThemeProvider declares the smrt layer order
 * in <head>, and a layered component's emitted CSS carries `@layer smrt.theme`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { compile } from 'svelte/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SMRT_CASCADE_LAYERS_CSS } from '../../styles/layers.js';
import ThemeProvider from '../ThemeProvider.svelte';

function child() {
  return createRawSnippet(() => ({ render: () => '<span>child</span>' }));
}

describe('smrt cascade layers', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    cleanup();
    document.getElementById('smrt-cascade-layers')?.remove();
  });

  it('ThemeProvider injects the layer order declaration into head', () => {
    render(ThemeProvider, { props: { children: child() } });
    const style = document.getElementById('smrt-cascade-layers');
    expect(style).not.toBeNull();
    expect(style?.textContent).toBe(SMRT_CASCADE_LAYERS_CSS);
    expect(style?.textContent).toContain(
      '@layer smrt.reset, smrt.structure, smrt.theme;',
    );
  });

  it('a layered component emits CSS inside @layer smrt.theme', () => {
    const file = resolve(process.cwd(), 'src/components/ui/Button.svelte');
    const source = readFileSync(file, 'utf8');
    const out = compile(source, {
      filename: file,
      generate: 'client',
      css: 'external',
    });
    expect(out.css?.code).toContain('@layer smrt.theme {');
  });
});
