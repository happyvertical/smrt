import {
  createThemeFromColor,
  isValidPreset,
  registerTheme,
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
  return (
    isValidPreset(theme.preset) ? theme.preset : DEFAULT_THEME_PRESET
  ) as ThemePreset;
}
