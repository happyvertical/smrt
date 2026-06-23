/**
 * Unit tests for the theme CSS generator (coverage uplift, S6 gate).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateAllThemesCSS,
  generateThemeCSS,
  generateThemeVariables,
  variablesToStyleString,
} from '../css-generator';
import { getTheme } from '../registry';

// Raw CSS text of the static studio preset, used to prove the static-CSS
// delivery path and the JS generator emit identical elevation values (#1586).
// Resolved from process.cwd() (NOT import.meta.url): the smrt-vitest plugin runs
// each package's suite with cwd === the package root, so this is stable here,
// whereas `new URL('…', import.meta.url)` fails to resolve under the vite-node
// loader this suite runs in.
const studioCss = readFileSync(
  join(process.cwd(), 'src/themes/styles/studio.css'),
  'utf8',
);

/**
 * Pull the `--smrt-elevation-0..5` values out of a specific
 * `[data-theme="<preset>"][data-color-scheme="<scheme>"]` block of a static CSS
 * preset file.
 */
function staticElevation(
  css: string,
  preset: string,
  scheme: 'light' | 'dark',
): Record<string, string> {
  const selector = `[data-theme="${preset}"][data-color-scheme="${scheme}"]`;
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`block not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = line.match(/(--smrt-elevation-\d):\s*(.+);/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

describe('theme CSS generator', () => {
  const theme = getTheme('material');

  it('generateThemeVariables returns --smrt-* custom properties', () => {
    const vars = generateThemeVariables(theme);
    const keys = Object.keys(vars);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.startsWith('--smrt-'))).toBe(true);
  });

  it('variablesToStyleString emits "name: value;" declarations', () => {
    const css = variablesToStyleString({
      '--smrt-x': '1px',
      '--smrt-y': 'red',
    });
    expect(css).toContain('--smrt-x: 1px');
    expect(css).toContain('--smrt-y: red');
  });

  it('generateThemeCSS produces an embeddable block', () => {
    const css = generateThemeCSS(theme);
    expect(typeof css).toBe('string');
    expect(css).toContain('--smrt-');
  });

  it('generateAllThemesCSS resolves to a non-empty string', async () => {
    const css = await generateAllThemesCSS();
    expect(css.length).toBeGreaterThan(0);
  });

  describe('studio per-scheme elevation (#1586)', () => {
    const studio = getTheme('studio');

    it('emits distinct dark-scheme elevation, not the light values', () => {
      const light = generateThemeVariables(studio, false);
      const dark = generateThemeVariables(studio, true);
      // Level 1 is a white inset hairline in dark vs a tinted inset in light.
      expect(dark['--smrt-elevation-1']).toContain('rgba(255, 255, 255');
      expect(light['--smrt-elevation-1']).toContain('rgba(60, 64, 67');
      expect(dark['--smrt-elevation-1']).not.toBe(light['--smrt-elevation-1']);
      // Deeper black shadows above level 1.
      expect(dark['--smrt-elevation-5']).toContain('rgba(0, 0, 0, 0.25)');
    });

    it('matches the static studio.css for both schemes (drift guard)', () => {
      // The static-CSS delivery path and the JS generator must agree on VALUES,
      // not just token names — this is what let the studio dark shadows diverge.
      for (const scheme of ['light', 'dark'] as const) {
        const generated = generateThemeVariables(studio, scheme === 'dark');
        const fromCss = staticElevation(studioCss, 'studio', scheme);
        for (let level = 0; level <= 5; level += 1) {
          const key = `--smrt-elevation-${level}`;
          expect(fromCss[key], `${scheme} ${key}`).toBe(generated[key]);
        }
      }
    });
  });
});
