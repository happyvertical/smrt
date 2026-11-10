import {
  createThemeFromColor,
  getTheme,
  registerTheme,
  type Theme,
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
  const fontFamily = theme?.fontFamily ?? custom?.fontFamily;
  const font = fontFamily ? THEME_FONTS[fontFamily] : undefined;
  if (!custom) {
    const basePreset = theme?.preset ?? DEFAULT_PRESET;
    if (!font) return { preset: basePreset, colorScheme };
    const id = `planner-preset-${basePreset}-${fontFamily?.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    if (!registered.has(id)) {
      const base = getTheme(basePreset as Parameters<typeof getTheme>[0]);
      const typography = Object.fromEntries(
        Object.entries(base.typography).map(([key, token]) => [
          key,
          { ...token, fontFamily: 'var(--smrt-font-family)' },
        ]),
      ) as Theme['typography'];
      registerTheme({
        ...base,
        id: id as Theme['id'],
        fontFamily: font,
        typography,
      });
      registered.add(id);
    }
    return { preset: id, colorScheme };
  }
  const id = brandThemeId(custom.primary, fontFamily);
  if (!registered.has(id)) {
    registerTheme(
      createThemeFromColor(custom.primary, id, 'Brand colour', {
        ...(font ? { fontFamily: font } : {}),
      }),
    );
    registered.add(id);
  }
  return { preset: id, colorScheme };
}
