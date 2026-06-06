/**
 * Design-token alias contract (issue #1431).
 *
 * Components consume a Material-3 token vocabulary (`radius-small`,
 * `duration-short2`, `spacing-md`, `typography-*-font`, …) that must resolve to
 * real values across every preset. These tests pin the additive aliases emitted
 * by the canonical preset generator (`css-generator.ts`) and the simple
 * `src/theme/` ThemeProvider so a regression that drops a consumed alias fails
 * here as well as in scripts/check-svelte-tokens.mjs.
 */

import { describe, expect, it } from 'vitest';
import { generateThemeVariables as generateSimpleThemeVariables } from '../../theme/tokens.js';
import { generateThemeVariables } from '../css-generator.js';
import { themes } from '../registry.js';

/** Material-3 + helper aliases that components consume and expect emitted. */
const REQUIRED_ALIASES = [
  // Radius (Material-3 named scale)
  '--smrt-radius-extra-small',
  '--smrt-radius-small',
  '--smrt-radius-medium',
  '--smrt-radius-large',
  '--smrt-radius-extra-large',
  // Motion (Material-3 duration scale)
  '--smrt-duration-short1',
  '--smrt-duration-short2',
  '--smrt-duration-short3',
  '--smrt-duration-short4',
  '--smrt-duration-medium1',
  '--smrt-duration-medium2',
  '--smrt-duration-medium3',
  '--smrt-duration-medium4',
  '--smrt-duration-long1',
  '--smrt-duration-long2',
  '--smrt-duration-long3',
  '--smrt-duration-long4',
  // Helper tokens (theme-independent)
  '--smrt-font-family-mono',
  '--smrt-typography-weight-normal',
  '--smrt-typography-weight-medium',
  '--smrt-typography-weight-semibold',
  '--smrt-typography-weight-bold',
  '--smrt-z-index-dialog',
];

/** Spacing aliases are only emitted by the preset generator. */
const PRESET_ONLY_ALIASES = [
  '--smrt-spacing-xs',
  '--smrt-spacing-sm',
  '--smrt-spacing-md',
  '--smrt-spacing-lg',
  '--smrt-spacing-xl',
  '--smrt-spacing-2xl',
  '--smrt-spacing-3xl',
];

const TYPOGRAPHY_FONT_SHORTHANDS = [
  '--smrt-typography-body-large-font',
  '--smrt-typography-body-medium-font',
  '--smrt-typography-body-small-font',
  '--smrt-typography-label-large-font',
  '--smrt-typography-label-medium-font',
  '--smrt-typography-label-small-font',
  '--smrt-typography-title-large-font',
  '--smrt-typography-title-medium-font',
  '--smrt-typography-title-small-font',
  '--smrt-typography-headline-small-font',
  '--smrt-typography-headline-medium-font',
];

describe('preset generator alias emission (#1431)', () => {
  for (const theme of Object.values(themes)) {
    for (const isDark of [false, true]) {
      it(`${theme.id} ${isDark ? 'dark' : 'light'} emits every consumed alias`, () => {
        const vars = generateThemeVariables(theme, isDark);
        for (const token of [
          ...REQUIRED_ALIASES,
          ...PRESET_ONLY_ALIASES,
          ...TYPOGRAPHY_FONT_SHORTHANDS,
        ]) {
          expect(vars[token], `${token} should be emitted`).toBeDefined();
          expect(vars[token]).not.toBe('');
        }
      });
    }
  }

  it('maps Material-3 radius aliases onto canonical t-shirt values', () => {
    const vars = generateThemeVariables(themes.material, false);
    expect(vars['--smrt-radius-small']).toBe(vars['--smrt-radius-sm']);
    expect(vars['--smrt-radius-medium']).toBe(vars['--smrt-radius-md']);
    expect(vars['--smrt-radius-large']).toBe(vars['--smrt-radius-lg']);
  });

  it('maps named spacing aliases onto numeric-scale values', () => {
    const vars = generateThemeVariables(themes.material, false);
    expect(vars['--smrt-spacing-sm']).toBe(vars['--smrt-spacing-2']);
    expect(vars['--smrt-spacing-md']).toBe(vars['--smrt-spacing-4']);
    expect(vars['--smrt-spacing-xl']).toBe(vars['--smrt-spacing-8']);
  });

  it('builds the typography `font` shorthand from the emitted longhands', () => {
    const vars = generateThemeVariables(themes.material, false);
    const shorthand = vars['--smrt-typography-body-medium-font'];
    expect(shorthand).toContain(vars['--smrt-typography-body-medium-size']);
    // weight size/line-height family
    expect(shorthand).toMatch(/^\d+\s+\S+\/\S+\s+.+$/);
  });
});

describe('simple ThemeProvider alias emission (#1431)', () => {
  for (const isDark of [false, true]) {
    it(`${isDark ? 'dark' : 'light'} emits radius/duration/helper aliases`, () => {
      const vars = generateSimpleThemeVariables(isDark);
      for (const token of REQUIRED_ALIASES) {
        expect(vars[token], `${token} should be emitted`).toBeDefined();
        expect(vars[token]).not.toBe('');
      }
    });
  }
});
