/**
 * Unit tests for the theme registry (coverage uplift toward smrt-svelte's T2
 * floor, S11 #1416 / S6 gate). Pure logic — no rendering.
 */
import { describe, expect, it } from 'vitest';
import {
  availablePresets,
  getAllThemes,
  getCustomTheme,
  getTheme,
  getThemeName,
  getThemeOptions,
  hasCustomTheme,
  isValidPreset,
  registerCustomTheme,
  themes,
} from '../registry';

describe('theme registry', () => {
  it('returns each built-in preset from getTheme', () => {
    for (const preset of availablePresets) {
      const theme = getTheme(preset);
      expect(theme).toBeDefined();
      expect(theme.name).toBeTruthy();
    }
  });

  it('throws on an unknown preset', () => {
    expect(() => getTheme('nope' as never)).toThrow(/Unknown theme preset/);
  });

  it('validates presets', () => {
    expect(isValidPreset('material')).toBe(true);
    expect(isValidPreset('bogus')).toBe(false);
  });

  it('returns display names with a fallback', () => {
    expect(getThemeName('material')).toBe(themes.material.name);
    expect(getThemeName('bogus' as never)).toBe('bogus');
  });

  it('lists all built-in themes and options', () => {
    expect(getAllThemes()).toHaveLength(availablePresets.length);
    const options = getThemeOptions();
    expect(options.length).toBeGreaterThanOrEqual(availablePresets.length);
    expect(options[0]).toHaveProperty('value');
    expect(options[0]).toHaveProperty('label');
  });

  it('registers, resolves, and reports custom themes', () => {
    const custom = { id: 'unit-custom', name: 'Unit Custom' } as never;
    expect(hasCustomTheme('unit-custom')).toBe(false);
    registerCustomTheme(custom);
    expect(hasCustomTheme('unit-custom')).toBe(true);
    expect(getCustomTheme('unit-custom')).toBe(custom);
    expect(isValidPreset('unit-custom')).toBe(true);
    expect(getTheme('unit-custom' as never)).toBe(custom);
    expect(getThemeName('unit-custom' as never)).toBe('Unit Custom');
  });
});
