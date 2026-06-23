import { describe, expect, it } from 'vitest';
import {
  generateTheme,
  getContrastRatio,
  getLuminance,
  hexToRgb,
  meetsContrastAA,
  meetsContrastAAA,
  rgbToHex,
} from '../color';

describe('Theme Color Utilities', () => {
  it('should convert hex to rgb correctly', () => {
    expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('#FF5733')).toEqual({ r: 255, g: 87, b: 51 });
  });

  it('expands 3-digit shorthand hex (#abc -> #aabbcc) (#1586)', () => {
    // Regression: shorthand hex used to NaN-poison the b channel (only the first
    // 2 chars were read), corrupting any palette generated from a 3-digit seed.
    expect(hexToRgb('#abc')).toEqual({ r: 170, g: 187, b: 204 });
    expect(hexToRgb('#000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('parses functional rgb()/rgba() notation (#1586)', () => {
    expect(hexToRgb('rgb(0, 122, 255)')).toEqual({ r: 0, g: 122, b: 255 });
    expect(hexToRgb('rgb(0 122 255)')).toEqual({ r: 0, g: 122, b: 255 });
    expect(hexToRgb('rgba(0, 122, 255, 0.5)')).toEqual({
      r: 0,
      g: 122,
      b: 255,
    });
    expect(hexToRgb('rgb(100%, 0%, 50%)')).toEqual({ r: 255, g: 0, b: 128 });
  });

  it('should convert rgb to hex correctly', () => {
    expect(rgbToHex(0, 0, 0)).toBe('#000000');
    expect(rgbToHex(255, 255, 255)).toBe('#ffffff');
    expect(rgbToHex(255, 87, 51)).toBe('#ff5733');
  });

  it('should generate a theme palette from a seed color', () => {
    const seed = '#6750A4'; // M3 Baseline Purple
    const theme = generateTheme(seed);

    // Check for critical M3 keys
    expect(theme).toHaveProperty('primary');
    expect(theme).toHaveProperty('onPrimary');
    expect(theme).toHaveProperty('primaryContainer');
    expect(theme).toHaveProperty('onPrimaryContainer');
    expect(theme).toHaveProperty('secondary');
    expect(theme).toHaveProperty('surface');
    expect(theme).toHaveProperty('background');
    expect(theme).toHaveProperty('error');

    // Basic validity check (strings should be hex colors)
    expect(theme.primary).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('should generate different palettes for light and dark modes', () => {
    const seed = '#6750A4';
    const lightTheme = generateTheme(seed, 'light');
    const darkTheme = generateTheme(seed, 'dark');

    expect(lightTheme.primary).not.toBe(darkTheme.primary);
    // In M3, dark mode primary is usually lighter/desaturated compared to light mode
  });
});

describe('Color Contrast Utilities', () => {
  it('should calculate luminance correctly', () => {
    // Black has luminance 0
    expect(getLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    // White has luminance 1
    expect(getLuminance({ r: 255, g: 255, b: 255 })).toBe(1);
    // Mid gray should be around 0.2
    const midGray = getLuminance({ r: 128, g: 128, b: 128 });
    expect(midGray).toBeGreaterThan(0.1);
    expect(midGray).toBeLessThan(0.3);
  });

  it('should calculate contrast ratio correctly', () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };

    // Black on white should be 21:1 (maximum contrast)
    expect(getContrastRatio(black, white)).toBeCloseTo(21, 0);

    // Same color should be 1:1 (no contrast)
    expect(getContrastRatio(black, black)).toBe(1);
  });

  it('should validate WCAG AA contrast requirements', () => {
    // Black on white passes AA
    expect(meetsContrastAA('#000000', '#ffffff')).toBe(true);

    // Light gray on white fails AA for normal text
    expect(meetsContrastAA('#999999', '#ffffff')).toBe(false);

    // Light gray on white passes AA for large text (3:1 threshold)
    expect(meetsContrastAA('#767676', '#ffffff', true)).toBe(true);
  });

  it('should validate WCAG AAA contrast requirements', () => {
    // Black on white passes AAA
    expect(meetsContrastAAA('#000000', '#ffffff')).toBe(true);

    // Medium gray on white fails AAA for normal text (needs 7:1)
    expect(meetsContrastAAA('#666666', '#ffffff')).toBe(false);

    // Darker gray passes AAA for large text (4.5:1 threshold)
    expect(meetsContrastAAA('#595959', '#ffffff', true)).toBe(true);
  });
});
