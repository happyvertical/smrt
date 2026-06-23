export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

// Minimal Theme Interface matching M3
export interface Theme {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  secondary: string;
  onSecondary: string;
  secondaryContainer: string;
  onSecondaryContainer: string;
  tertiary: string;
  onTertiary: string;
  tertiaryContainer: string;
  onTertiaryContainer: string;
  error: string;
  onError: string;
  errorContainer: string;
  onErrorContainer: string;
  background: string;
  onBackground: string;
  surface: string;
  onSurface: string;
  surfaceVariant: string;
  onSurfaceVariant: string;
  outline: string;
  outlineVariant: string;
  shadow: string;
  scrim: string;
  inverseSurface: string;
  inverseOnSurface: string;
  inversePrimary: string;
  surfaceDim: string;
  surfaceBright: string;
  surfaceContainerLowest: string;
  surfaceContainerLow: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  surfaceContainerHighest: string;
}

/**
 * Parse a CSS color string into an {@link Rgb}.
 *
 * Accepts 6-digit hex (`#rrggbb`), 3-digit shorthand hex (`#rgb`, expanded by
 * doubling each nibble), and functional `rgb()` / `rgba()` notation (commas or
 * spaces, integer or percentage channels). Named colors and other formats are
 * not supported and yield `{ r: NaN, g: NaN, b: NaN }`; callers that accept
 * arbitrary input should validate before relying on the result.
 *
 * The leading `#` is optional for hex input.
 */
export function hexToRgb(hex: string): Rgb {
  const input = hex.trim();

  // Functional rgb()/rgba() notation, e.g. rgb(0, 122, 255) or rgb(0 122 255 / .5).
  const rgbMatch = input.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const channels = rgbMatch[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .slice(0, 3);
    const toChannel = (part: string): number => {
      if (part.endsWith('%')) {
        return Math.round((Number.parseFloat(part) / 100) * 255);
      }
      return Number.parseInt(part, 10);
    };
    const [r, g, b] = channels.map(toChannel);
    return { r, g, b };
  }

  const cleanHex = input.replace('#', '');

  // 3-digit shorthand hex: #abc -> #aabbcc.
  if (cleanHex.length === 3) {
    const r = Number.parseInt(cleanHex[0] + cleanHex[0], 16);
    const g = Number.parseInt(cleanHex[1] + cleanHex[1], 16);
    const b = Number.parseInt(cleanHex[2] + cleanHex[2], 16);
    return { r, g, b };
  }

  const r = Number.parseInt(cleanHex.substring(0, 2), 16);
  const g = Number.parseInt(cleanHex.substring(2, 4), 16);
  const b = Number.parseInt(cleanHex.substring(4, 6), 16);
  return { r, g, b };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) => {
    const hex = Math.round(Math.max(0, Math.min(255, c))).toString(16);
    return hex.length === 1 ? `0${hex}` : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Calculate relative luminance of a color per WCAG 2.1
 * https://www.w3.org/WAI/GL/wiki/Relative_luminance
 */
export function getLuminance(rgb: Rgb): number {
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((c) => {
    const sRGB = c / 255;
    return sRGB <= 0.03928 ? sRGB / 12.92 : ((sRGB + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Calculate contrast ratio between two colors per WCAG 2.1
 * Returns a value between 1 and 21
 */
export function getContrastRatio(fg: Rgb, bg: Rgb): number {
  const L1 = getLuminance(fg);
  const L2 = getLuminance(bg);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Check if contrast meets WCAG AA standard (4.5:1 for normal text, 3:1 for large text)
 */
export function meetsContrastAA(
  fg: string | Rgb,
  bg: string | Rgb,
  largeText = false,
): boolean {
  const fgRgb = typeof fg === 'string' ? hexToRgb(fg) : fg;
  const bgRgb = typeof bg === 'string' ? hexToRgb(bg) : bg;
  const ratio = getContrastRatio(fgRgb, bgRgb);
  return ratio >= (largeText ? 3 : 4.5);
}

/**
 * Check if contrast meets WCAG AAA standard (7:1 for normal text, 4.5:1 for large text)
 */
export function meetsContrastAAA(
  fg: string | Rgb,
  bg: string | Rgb,
  largeText = false,
): boolean {
  const fgRgb = typeof fg === 'string' ? hexToRgb(fg) : fg;
  const bgRgb = typeof bg === 'string' ? hexToRgb(bg) : bg;
  const ratio = getContrastRatio(fgRgb, bgRgb);
  return ratio >= (largeText ? 4.5 : 7);
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0,
    s = 0,
    l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  h /= 360;
  s /= 100;
  l /= 100;
  let r: number, g: number, b: number;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}

function hslToHex(h: number, s: number, l: number): string {
  const { r, g, b } = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

// Generate a color with the same Hue and Saturation but specific Lightness
function tone(h: number, s: number, l: number): string {
  return hslToHex(h, s, l);
}

export function generateTheme(
  seedColor: string,
  mode: 'light' | 'dark' = 'light',
): Theme {
  const rgb = hexToRgb(seedColor);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

  // Tonal Palettes (Simplified M3 Logic)
  // Primary: Keep seed hue/sat
  const p_h = hsl.h;
  const p_s = Math.max(hsl.s, 40); // Ensure some vibrancy

  // Secondary: Less vibrant
  const s_h = p_h;
  const s_s = Math.max(p_s / 3, 20);

  // Tertiary: Shifted hue
  const t_h = (p_h + 60) % 360;
  const t_s = Math.max(p_s / 1.5, 30);

  // Neutral
  const n_h = p_h;
  const n_s = Math.min(p_s / 10, 8); // Very low saturation

  // Neutral Variant
  const nv_h = p_h;
  const nv_s = Math.min(p_s / 6, 16);

  // Error (Red)
  const e_h = 0; // Red
  const e_s = 80;

  if (mode === 'light') {
    return {
      primary: tone(p_h, p_s, 40),
      onPrimary: tone(p_h, p_s, 100),
      primaryContainer: tone(p_h, p_s, 90),
      onPrimaryContainer: tone(p_h, p_s, 10),

      secondary: tone(s_h, s_s, 40),
      onSecondary: tone(s_h, s_s, 100),
      secondaryContainer: tone(s_h, s_s, 90),
      onSecondaryContainer: tone(s_h, s_s, 10),

      tertiary: tone(t_h, t_s, 40),
      onTertiary: tone(t_h, t_s, 100),
      tertiaryContainer: tone(t_h, t_s, 90),
      onTertiaryContainer: tone(t_h, t_s, 10),

      error: tone(e_h, e_s, 40),
      onError: tone(e_h, e_s, 100),
      errorContainer: tone(e_h, e_s, 90),
      onErrorContainer: tone(e_h, e_s, 10),

      background: tone(n_h, n_s, 99),
      onBackground: tone(n_h, n_s, 10),
      surface: tone(n_h, n_s, 99),
      onSurface: tone(n_h, n_s, 10),

      surfaceVariant: tone(nv_h, nv_s, 90),
      onSurfaceVariant: tone(nv_h, nv_s, 30),
      outline: tone(nv_h, nv_s, 50),
      outlineVariant: tone(nv_h, nv_s, 80),

      shadow: tone(0, 0, 0),
      scrim: tone(0, 0, 0),
      inverseSurface: tone(n_h, n_s, 20),
      inverseOnSurface: tone(n_h, n_s, 95),
      inversePrimary: tone(p_h, p_s, 80),

      surfaceDim: tone(n_h, n_s, 87),
      surfaceBright: tone(n_h, n_s, 98),
      surfaceContainerLowest: tone(n_h, n_s, 100),
      surfaceContainerLow: tone(n_h, n_s, 96),
      surfaceContainer: tone(n_h, n_s, 94),
      surfaceContainerHigh: tone(n_h, n_s, 92),
      surfaceContainerHighest: tone(n_h, n_s, 90),
    };
  } else {
    // Dark Mode mappings
    return {
      primary: tone(p_h, p_s, 80),
      onPrimary: tone(p_h, p_s, 20),
      primaryContainer: tone(p_h, p_s, 30),
      onPrimaryContainer: tone(p_h, p_s, 90),

      secondary: tone(s_h, s_s, 80),
      onSecondary: tone(s_h, s_s, 20),
      secondaryContainer: tone(s_h, s_s, 30),
      onSecondaryContainer: tone(s_h, s_s, 90),

      tertiary: tone(t_h, t_s, 80),
      onTertiary: tone(t_h, t_s, 20),
      tertiaryContainer: tone(t_h, t_s, 30),
      onTertiaryContainer: tone(t_h, t_s, 90),

      error: tone(e_h, e_s, 80),
      onError: tone(e_h, e_s, 20),
      errorContainer: tone(e_h, e_s, 30),
      onErrorContainer: tone(e_h, e_s, 90),

      background: tone(n_h, n_s, 10),
      onBackground: tone(n_h, n_s, 90),
      surface: tone(n_h, n_s, 10),
      onSurface: tone(n_h, n_s, 90),

      surfaceVariant: tone(nv_h, nv_s, 30),
      onSurfaceVariant: tone(nv_h, nv_s, 80),
      outline: tone(nv_h, nv_s, 60),
      outlineVariant: tone(nv_h, nv_s, 30),

      shadow: tone(0, 0, 0),
      scrim: tone(0, 0, 0),
      inverseSurface: tone(n_h, n_s, 90),
      inverseOnSurface: tone(n_h, n_s, 20),
      inversePrimary: tone(p_h, p_s, 40),

      surfaceDim: tone(n_h, n_s, 6),
      surfaceBright: tone(n_h, n_s, 24),
      surfaceContainerLowest: tone(n_h, n_s, 4),
      surfaceContainerLow: tone(n_h, n_s, 10),
      surfaceContainer: tone(n_h, n_s, 12),
      surfaceContainerHigh: tone(n_h, n_s, 17),
      surfaceContainerHighest: tone(n_h, n_s, 22),
    };
  }
}
