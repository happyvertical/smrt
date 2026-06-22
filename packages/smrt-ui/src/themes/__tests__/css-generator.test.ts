/**
 * Unit tests for the theme CSS generator (coverage uplift, S6 gate).
 */
import { describe, expect, it } from 'vitest';
import {
  generateAllThemesCSS,
  generateThemeCSS,
  generateThemeVariables,
  variablesToStyleString,
} from '../css-generator';
import { getTheme } from '../registry';

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
});
