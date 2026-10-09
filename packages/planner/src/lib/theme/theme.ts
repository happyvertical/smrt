import { availablePresets } from '@happyvertical/smrt-ui/themes';

/**
 * The app's look, kept in the app document (smrt#3604): a built-in smrt-ui
 * preset, a light/dark/system choice and optionally a brand colour that
 * `createThemeFromColor` expands into a full theme. Tokens only, never CSS.
 * Absent means the default (the `smrt` preset, following the system scheme).
 */
export type ColorSchemeSetting = 'light' | 'dark' | 'system';

export interface CustomTheme {
  /** `#rrggbb`, lowercase. */
  primary: string;
  /** A key of `THEME_FONTS`. */
  fontFamily?: string;
}

export interface ThemeSetting {
  /** A built-in smrt-ui preset; the default when absent. */
  preset?: string;
  colorScheme?: ColorSchemeSetting;
  /** A brand colour theme; wins over `preset` while present. */
  custom?: CustomTheme;
}

export const THEME_PRESETS: readonly string[] = availablePresets;
export const DEFAULT_PRESET = 'smrt';
export const DEFAULT_COLOR_SCHEME: ColorSchemeSetting = 'system';
export const COLOR_SCHEMES: readonly ColorSchemeSetting[] = [
  'light',
  'dark',
  'system',
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
    primary: theme?.custom?.primary ?? null,
    font: theme?.custom ? (theme.custom.fontFamily ?? null) : null,
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
  if (theme.custom) out.custom = { ...theme.custom };
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
