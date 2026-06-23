/**
 * Regression tests for createTheme color handling (#1586, epic #1354).
 *
 * The dark-color derivation and primary-container derivation used to assume the
 * primary was 6-digit hex. For `rgb()`, 3-digit hex, or a named color they
 * emitted invalid CSS — `rgb(0,122,255)20`, `#f6320`, `#NaNNaNNaN`. Inputs are
 * now normalized to RGB first (or rejected with a clear error), so the generated
 * palette is always valid CSS.
 */
import { describe, expect, it } from 'vitest';
import { createTheme } from '../create-theme';
import type { ColorPalette } from '../types';

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX_ALPHA = /^#[0-9a-fA-F]{8}$/;

/** Every color value in a palette must be syntactically valid CSS. */
function expectAllColorsValid(colors: ColorPalette) {
  for (const [key, value] of Object.entries(colors)) {
    expect(typeof value).toBe('string');
    // The regression: derivations used to emit '#NaNNaNNaN' / 'rgb(...)20'.
    expect(value, `${key}=${value}`).not.toContain('NaN');
    // Hex values must be well-formed: exactly 3, 4, 6, or 8 digits (all valid
    // CSS). A 5- or 7-digit hex (e.g. the '#f6320' the bug produced) must fail.
    // rgb()/rgba() and other formats pass through unchanged.
    if (value.startsWith('#')) {
      expect(value, `${key}=${value}`).toMatch(
        /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
      );
    }
  }
}

describe('createTheme color handling (#1586)', () => {
  it('derives a valid primary container from a 6-digit hex primary', () => {
    const theme = createTheme({
      id: 'brand6',
      name: 'Brand 6',
      light: { primary: '#0b57d0', background: '#ffffff' },
    });
    // 8-digit hex alpha form: primary + "20".
    expect(theme.light.primaryContainer).toMatch(HEX_ALPHA);
    expect(theme.light.primaryContainer.toLowerCase()).toBe('#0b57d020');
    expectAllColorsValid(theme.light);
    expectAllColorsValid(theme.dark);
  });

  it('normalizes an rgb() primary instead of emitting invalid CSS', () => {
    const theme = createTheme({
      id: 'brandRgb',
      name: 'Brand RGB',
      light: { primary: 'rgb(0, 122, 255)', background: '#ffffff' },
    });
    // Was 'rgb(0, 122, 255)20' (invalid); now a normalized 8-digit hex.
    expect(theme.light.primaryContainer).not.toContain('rgb(');
    expect(theme.light.primaryContainer).toMatch(HEX_ALPHA);
    expect(theme.light.primaryContainer.toLowerCase()).toBe('#007aff20');
    // Auto-generated dark colors used to be '#NaNNaNNaN' for an rgb() input;
    // every value is now valid CSS (hex values are well-formed, rgb() values
    // pass through unchanged).
    expectAllColorsValid(theme.light);
    expectAllColorsValid(theme.dark);
    // The brightness-derived dark colors normalize to proper hex.
    expect(theme.dark.onPrimary).toMatch(HEX6);
    expect(theme.dark.secondary).toMatch(HEX6);
  });

  it('expands a 3-digit hex primary correctly', () => {
    const theme = createTheme({
      id: 'brand3',
      name: 'Brand 3',
      light: { primary: '#07f', background: '#fff' },
    });
    // '#07f' -> '#0077ff', container '#0077ff20'.
    expect(theme.light.primaryContainer.toLowerCase()).toBe('#0077ff20');
    expectAllColorsValid(theme.light);
    expectAllColorsValid(theme.dark);
    expect(theme.dark.onPrimary).toMatch(HEX6);
  });

  it('throws a clear error for an unsupported named color', () => {
    expect(() =>
      createTheme({
        id: 'brandNamed',
        name: 'Brand Named',
        light: { primary: 'tomato', background: '#ffffff' },
      }),
    ).toThrow(/unsupported color "tomato"/);
  });
});
