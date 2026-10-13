/**
 * Premium-baseline token families (epic #3864, issue #3865): every preset and
 * `createTheme()` output defines every new token in both schemes.
 */
import { describe, expect, it } from 'vitest';
import { createTheme, createThemeFromColor } from '../create-theme.js';
import { generateThemeVariables } from '../css-generator.js';
import { availablePresets, getTheme } from '../registry.js';

const BASELINE_TOKENS = [
  ...['ground', 'panel', 'control', 'raised', 'sunken', 'overlay'].map(
    (k) => `--smrt-surface-${k}`,
  ),
  '--smrt-hairline-color',
  '--smrt-hairline-strong-color',
  '--smrt-hairline',
  '--smrt-hairline-strong',
  '--smrt-inset-highlight',
  ...['hover', 'pressed', 'selected', 'focus', 'dragged', 'disabled'].map(
    (k) => `--smrt-state-${k}`,
  ),
  '--smrt-shadow-color',
  ...[
    'radius',
    'radius-small',
    'height',
    'height-small',
    'weight',
    'border',
  ].map((k) => `--smrt-control-${k}`),
  '--smrt-focus-ring-color',
  '--smrt-focus-ring-width',
  '--smrt-focus-ring-offset',
  '--smrt-accent-color',
  '--smrt-selection-background',
  '--smrt-selection-color',
  '--smrt-caret-color',
  '--smrt-scrollbar-thumb',
  '--smrt-scrollbar-track',
  '--smrt-glass-blur',
  '--smrt-glass-saturation',
  '--smrt-glass-surface',
  '--smrt-glass-surface-strong',
  '--smrt-glass-border',
  '--smrt-duration-scheme',
  '--smrt-font-feature-settings',
];

describe('premium baseline tokens', () => {
  for (const preset of availablePresets) {
    for (const isDark of [false, true]) {
      it(`${preset} ${isDark ? 'dark' : 'light'} defines every baseline token`, () => {
        const vars = generateThemeVariables(getTheme(preset), isDark);
        for (const token of BASELINE_TOKENS) {
          expect(vars[token], token).toBeTruthy();
        }
        expect(vars['--smrt-hairline']).toBe(
          '1px solid var(--smrt-hairline-color)',
        );
        expect(vars['--smrt-shadow-color']).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
      });
    }
  }

  it('removes the superseded glass opacity tokens', () => {
    const vars = generateThemeVariables(getTheme('glass'), false);
    expect(vars['--smrt-glass-border-opacity']).toBeUndefined();
    expect(vars['--smrt-glass-background-opacity']).toBeUndefined();
  });

  it('non-glass presets are opaque; glass blurs', () => {
    expect(
      generateThemeVariables(getTheme('material'), false)['--smrt-glass-blur'],
    ).toBe('0px');
    expect(
      generateThemeVariables(getTheme('glass'), true)['--smrt-glass-blur'],
    ).toBe('20px');
  });

  it('createTheme derives the families from the palette', () => {
    const theme = createTheme({
      id: 'derived',
      name: 'Derived',
      light: { primary: '#ff6b35', background: '#fafafa' },
    });
    for (const isDark of [false, true]) {
      const vars = generateThemeVariables(theme, isDark);
      for (const token of BASELINE_TOKENS)
        expect(vars[token], token).toBeTruthy();
    }
    const light = generateThemeVariables(theme, false);
    const dark = generateThemeVariables(theme, true);
    expect(light['--smrt-hairline-color']).toBe(
      'color-mix(in srgb, var(--smrt-color-on-surface) 12%, transparent)',
    );
    expect(light['--smrt-hairline-strong-color']).toContain('20%');
    expect(light['--smrt-state-hover']).toBe('0.08');
    expect(light['--smrt-state-disabled']).toBe('0.38');
    expect(light['--smrt-control-radius']).toBe('var(--smrt-radius-md)');
    expect(light['--smrt-control-height']).toBe('2.75rem');
    expect(light['--smrt-control-border']).toBe('var(--smrt-hairline-strong)');
    expect(light['--smrt-inset-highlight']).toBe('none');
    expect(dark['--smrt-inset-highlight']).toContain('inset 0 1px 0');
    expect(light['--smrt-surface-ground']).toBe('#fafafa');
    expect(light['--smrt-glass-blur']).toBe('0px');
    expect(light['--smrt-accent-color']).toBe('var(--smrt-color-primary)');
  });

  it('createTheme overrides win over derived defaults', () => {
    const theme = createThemeFromColor('#0b57d0', 'ovr', 'Ovr', {
      states: { hover: '0.1' },
      controls: { height: '3rem' },
      fontFeatureSettings: '"tnum" 1',
    });
    const vars = generateThemeVariables(theme, false);
    expect(vars['--smrt-state-hover']).toBe('0.1');
    expect(vars['--smrt-state-pressed']).toBe('0.12');
    expect(vars['--smrt-control-height']).toBe('3rem');
    expect(vars['--smrt-control-height-small']).toBe('2.25rem');
    expect(vars['--smrt-font-feature-settings']).toBe('"tnum" 1');
  });

  it('a theme without baseline sections still gets every token', () => {
    const {
      surfaces,
      hairlines,
      states,
      shadowColor,
      controls,
      focus,
      native,
      ...bare
    } = getTheme('material');
    void [surfaces, hairlines, states, shadowColor, controls, focus, native];
    const vars = generateThemeVariables(bare, true);
    for (const token of BASELINE_TOKENS)
      expect(vars[token], token).toBeTruthy();
  });
});
