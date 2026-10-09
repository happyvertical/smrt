import {
  createThemeFromColor,
  registerTheme,
} from '@happyvertical/smrt-ui/themes';
import {
  type ColorSchemeSetting,
  DEFAULT_COLOR_SCHEME,
  DEFAULT_PRESET,
  THEME_FONTS,
  type ThemeSetting,
} from './theme.ts';

/** What `ThemeProvider` is told: a preset id (built-in or registered) and a scheme. */
export interface ResolvedTheme {
  preset: string;
  colorScheme: ColorSchemeSetting;
}

const registered = new Set<string>();

/** The brand theme's id: unique per colour and font, since a registered id never changes. */
export function brandThemeId(primary: string, fontFamily?: string): string {
  return `planner-brand-${primary.slice(1)}${fontFamily ? `-${fontFamily.toLowerCase().replace(/[^a-z0-9]/g, '')}` : ''}`;
}

/**
 * The preset id and scheme a theme means, registering its brand theme through
 * `createThemeFromColor` first. Registered ids are never reused for another
 * colour, because `ThemeProvider` looks a theme up once per preset id.
 */
export function resolveTheme(theme: ThemeSetting | undefined): ResolvedTheme {
  const colorScheme = theme?.colorScheme ?? DEFAULT_COLOR_SCHEME;
  const custom = theme?.custom;
  if (!custom) return { preset: theme?.preset ?? DEFAULT_PRESET, colorScheme };
  const id = brandThemeId(custom.primary, custom.fontFamily);
  if (!registered.has(id)) {
    const font = custom.fontFamily ? THEME_FONTS[custom.fontFamily] : undefined;
    registerTheme(
      createThemeFromColor(custom.primary, id, 'Brand colour', {
        ...(font ? { fontFamily: font } : {}),
      }),
    );
    registered.add(id);
  }
  return { preset: id, colorScheme };
}
