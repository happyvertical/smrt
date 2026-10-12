import {
  createThemeFromColor,
  getTheme,
  isValidPreset,
  registerTheme,
  type Theme,
  type ThemePreset,
} from '@happyvertical/smrt-ui/themes';
import { DEFAULT_THEME_PRESET, THEME_FONTS } from './theme.js';
import type { ResolvedCookbookTheme } from './types.js';

const registered = new Set<string>();

/**
 * The preset id `ThemeProvider` should use for a resolved cookbook theme.
 * A brand colour is registered through `createThemeFromColor` first; a
 * registered id is never reused for another colour because `ThemeProvider`
 * looks a theme up once per preset id (the id encodes colour and font).
 * An unknown preset name falls back to the default rather than breaking.
 */
export function applyCookbookTheme(theme: ResolvedCookbookTheme): ThemePreset {
  const { brand } = theme;
  if (brand) {
    if (!registered.has(theme.preset)) {
      const font = brand.fontFamily ? THEME_FONTS[brand.fontFamily] : undefined;
      registerTheme(
        createThemeFromColor(brand.primary, theme.preset, 'Brand colour', {
          ...(font ? { fontFamily: font } : {}),
        }),
      );
      registered.add(theme.preset);
    }
    return theme.preset as ThemePreset;
  }
  const basePreset = (
    isValidPreset(theme.preset) ? theme.preset : DEFAULT_THEME_PRESET
  ) as ThemePreset;
  const font = theme.fontFamily && THEME_FONTS[theme.fontFamily];
  if (!font) return basePreset;
  const id = `cookbook-preset-${basePreset}-${theme.fontFamily?.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  if (!registered.has(id)) {
    const base = getTheme(basePreset);
    const typography = Object.fromEntries(
      Object.entries(base.typography).map(([key, token]) => [
        key,
        { ...token, fontFamily: 'var(--smrt-font-family)' },
      ]),
    ) as Theme['typography'];
    registerTheme({
      ...base,
      id: id as ThemePreset,
      fontFamily: font,
      typography,
    });
    registered.add(id);
  }
  return id as ThemePreset;
}
