/**
 * The cookbook's `theme` as the shell applies it (#3749). Pure: registering a
 * brand colour with smrt-ui is the component's job (`brand-theme.ts`).
 */
import type { CookbookTheme } from '@happyvertical/smrt-types';
import type { ResolvedCookbookTheme } from './types.js';

export const DEFAULT_THEME_PRESET = 'smrt';
export const DEFAULT_COLOR_SCHEME = 'system' as const;

/** The fonts a brand theme may name, each with its CSS stack. A fixed list, never free text. */
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
  let digits = (match[1] as string).toLowerCase();
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
  return `#${digits}`;
}

/** The brand theme's id: unique per colour and font, since a registered id never changes. */
export function brandThemeId(primary: string, fontFamily?: string): string {
  const font = fontFamily
    ? `-${fontFamily.toLowerCase().replace(/[^a-z0-9]/g, '')}`
    : '';
  return `cookbook-brand-${primary.replace('#', '')}${font}`;
}

/**
 * The preset and scheme a theme means. Lenient: a bad colour or font is
 * ignored rather than throwing, because a hand-edited file must still render
 * (`validateCookbook` is where it is rejected).
 */
export function resolveCookbookTheme(
  theme: CookbookTheme | undefined,
): ResolvedCookbookTheme {
  const colorScheme =
    theme?.colorScheme === 'light' || theme?.colorScheme === 'dark'
      ? theme.colorScheme
      : DEFAULT_COLOR_SCHEME;
  const primary = theme?.custom ? normalizeHex(theme.custom.primary) : null;
  if (theme?.custom && primary) {
    const font = theme.custom.fontFamily;
    const fontFamily =
      typeof font === 'string' && Object.hasOwn(THEME_FONTS, font)
        ? font
        : undefined;
    return {
      preset: brandThemeId(primary, fontFamily),
      colorScheme,
      brand: { primary, ...(fontFamily ? { fontFamily } : {}) },
    };
  }
  return { preset: theme?.preset || DEFAULT_THEME_PRESET, colorScheme };
}
