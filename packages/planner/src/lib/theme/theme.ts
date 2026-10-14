import { availablePresets } from '@happyvertical/smrt-ui/themes/presets';

/**
 * The app's look, kept in the app document (smrt#3604): a built-in smrt-ui
 * preset, a light/dark/system choice and optionally a brand colour that
 * `createThemeFromColor` expands into a full theme (it replaces the preset;
 * smrt-ui's `primaryColor`, which only tints a preset, is never used), plus
 * corner radius, density and contrast. Custom CSS is saved
 * with the cookbook and applied live by the Planner.
 * Absent means the default (the `glass` preset, following the system scheme).
 */
export type ColorSchemeSetting = 'light' | 'dark' | 'system';

export interface CustomTheme {
  /** `#rrggbb`, lowercase. */
  primary: string;
  /** A key of `THEME_FONTS`. */
  fontFamily?: string;
}

/** Corner radius scale (`ThemeProvider` `borderRadius`); `md` is the preset's own. */
export type BorderRadiusSetting = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
/** Control size: comfortable, or larger touch targets. */
export type DensitySetting = 'comfortable' | 'touch';
/** `auto` follows the device's contrast preference. */
export type ContrastSetting = 'auto' | 'standard' | 'more';

export interface ThemeSetting {
  /** A built-in smrt-ui preset; the default when absent. */
  preset?: string;
  colorScheme?: ColorSchemeSetting;
  /** Corner radius; absent keeps the preset's own. */
  borderRadius?: BorderRadiusSetting;
  /** Control density; absent is comfortable. */
  density?: DensitySetting;
  /** Contrast; absent follows the device. */
  contrast?: ContrastSetting;
  /** A font override that preserves the selected preset's palette. */
  fontFamily?: string;
  /** A brand colour theme; wins over `preset` while present. */
  custom?: CustomTheme;
  /** User-authored CSS carried with the cookbook and applied at runtime. */
  customCss?: string;
}

/** smrt-ui's built-in presets (its Node-safe `themes/presets` subpath). */
export const THEME_PRESETS: readonly string[] = availablePresets;
export const DEFAULT_PRESET = 'glass';
export const DEFAULT_COLOR_SCHEME: ColorSchemeSetting = 'system';
export const COLOR_SCHEMES: readonly ColorSchemeSetting[] = [
  'light',
  'dark',
  'system',
];

/** The cookbook's `theme.borderRadius` values (smrt-core's cookbook schema). */
export const BORDER_RADII: readonly BorderRadiusSetting[] = [
  'none',
  'sm',
  'md',
  'lg',
  'xl',
  'full',
];
export const DENSITIES: readonly DensitySetting[] = ['comfortable', 'touch'];
export const CONTRASTS: readonly ContrastSetting[] = [
  'auto',
  'standard',
  'more',
];

/** The fonts a theme may name, each with its CSS stack. A fixed list, never free text. */
export const THEME_FONTS: Readonly<Record<string, string>> = {
  'system-ui': 'system-ui, -apple-system, "Segoe UI", sans-serif',
  Inter: 'Inter, system-ui, sans-serif',
  Georgia: 'Georgia, "Times New Roman", serif',
  'ui-rounded': 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
  'ui-monospace': 'ui-monospace, "SF Mono", Menlo, monospace',
};

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#rgb` or `#rrggbb` (with or without `#`) as lowercase `#rrggbb`; else null. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = HEX.exec(value.trim());
  if (!match) return null;
  let digits = match[1].toLowerCase();
  if (digits.length === 3) {
    digits = [...digits].map((d) => d + d).join('');
  }
  return `#${digits}`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type ThemeParse =
  | { ok: true; theme: ThemeSetting | undefined }
  | { ok: false; error: string };

/**
 * Check a `theme` value from a file. Strict: a bad preset, colour, font or
 * scheme is an error, not silently dropped. An empty object reads as absent.
 */
export function parseTheme(value: unknown): ThemeParse {
  if (value === undefined) return { ok: true, theme: undefined };
  if (!isObject(value)) {
    return { ok: false, error: 'The cookbook "theme" must be an object.' };
  }
  const theme: ThemeSetting = {};
  if (value.preset !== undefined) {
    if (
      typeof value.preset !== 'string' ||
      !THEME_PRESETS.includes(value.preset)
    ) {
      return {
        ok: false,
        error: `The theme preset must be one of ${THEME_PRESETS.join(', ')}.`,
      };
    }
    theme.preset = value.preset;
  }
  if (value.colorScheme !== undefined) {
    if (!COLOR_SCHEMES.includes(value.colorScheme as ColorSchemeSetting)) {
      return {
        ok: false,
        error: 'The theme colorScheme must be light, dark or system.',
      };
    }
    theme.colorScheme = value.colorScheme as ColorSchemeSetting;
  }
  for (const [key, allowed] of [
    ['borderRadius', BORDER_RADII],
    ['density', DENSITIES],
    ['contrast', CONTRASTS],
  ] as const) {
    const given = value[key];
    if (given === undefined) continue;
    if (!(allowed as readonly unknown[]).includes(given)) {
      return {
        ok: false,
        error: `The theme ${key} must be one of ${allowed.join(', ')}.`,
      };
    }
    (theme as Record<string, unknown>)[key] = given;
  }
  if (value.fontFamily !== undefined) {
    if (
      typeof value.fontFamily !== 'string' ||
      !Object.hasOwn(THEME_FONTS, value.fontFamily)
    ) {
      return {
        ok: false,
        error: `The theme font must be one of ${Object.keys(THEME_FONTS).join(', ')}.`,
      };
    }
    theme.fontFamily = value.fontFamily;
  }
  if (value.custom !== undefined) {
    if (!isObject(value.custom)) {
      return { ok: false, error: 'The theme "custom" must be an object.' };
    }
    const primary = normalizeHex(value.custom.primary);
    if (!primary) {
      return {
        ok: false,
        error: 'The theme custom primary must be a hex colour like #c2410c.',
      };
    }
    const custom: CustomTheme = { primary };
    if (value.custom.fontFamily !== undefined) {
      const font = value.custom.fontFamily;
      if (typeof font !== 'string' || !Object.hasOwn(THEME_FONTS, font)) {
        return {
          ok: false,
          error: `The theme font must be one of ${Object.keys(THEME_FONTS).join(', ')}.`,
        };
      }
      custom.fontFamily = font;
    }
    theme.custom = custom;
  }
  if (value.customCss !== undefined) {
    if (typeof value.customCss !== 'string') {
      return { ok: false, error: 'The theme customCss must be a string.' };
    }
    if (Array.from(value.customCss).length > 65536) {
      return {
        ok: false,
        error: 'The theme customCss is too long (65,536 characters maximum).',
      };
    }
    if (value.customCss) theme.customCss = value.customCss;
  }
  return { ok: true, theme: Object.keys(theme).length ? theme : undefined };
}

/** Same theme? Absent and `{}` are the same (the default). */
export function themeEquals(
  a: ThemeSetting | undefined,
  b: ThemeSetting | undefined,
): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(theme: ThemeSetting | undefined) {
  return {
    preset: theme?.preset ?? DEFAULT_PRESET,
    colorScheme: theme?.colorScheme ?? DEFAULT_COLOR_SCHEME,
    borderRadius: theme?.borderRadius ?? null,
    density: theme?.density ?? null,
    contrast: theme?.contrast ?? null,
    primary: theme?.custom?.primary ?? null,
    font: theme?.fontFamily ?? theme?.custom?.fontFamily ?? null,
    customCss: theme?.customCss ?? null,
  };
}

/** Drop defaults so an unchanged theme stays absent from the document. */
export function compactTheme(
  theme: ThemeSetting | undefined,
): ThemeSetting | undefined {
  if (!theme) return undefined;
  const out: ThemeSetting = {};
  if (theme.preset) out.preset = theme.preset;
  if (theme.colorScheme) out.colorScheme = theme.colorScheme;
  if (theme.borderRadius) out.borderRadius = theme.borderRadius;
  if (theme.density) out.density = theme.density;
  if (theme.contrast) out.contrast = theme.contrast;
  if (theme.fontFamily) out.fontFamily = theme.fontFamily;
  if (theme.custom) out.custom = { ...theme.custom };
  if (theme.customCss) out.customCss = theme.customCss;
  return Object.keys(out).length ? out : undefined;
}

/** A short phrase for the chat and the Settings tab, e.g. "Glass, dark". */
export function describeTheme(theme: ThemeSetting | undefined): string {
  const scheme = theme?.colorScheme ?? DEFAULT_COLOR_SCHEME;
  const base = theme?.custom
    ? `brand colour ${theme.custom.primary}`
    : (theme?.preset ?? DEFAULT_PRESET);
  return scheme === 'system' ? base : `${base}, ${scheme}`;
}
