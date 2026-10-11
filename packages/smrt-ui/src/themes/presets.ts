/**
 * Theme presets: ids, labels, and palettes only.
 *
 * Node-safe subpath (`@happyvertical/smrt-ui/themes/presets`): it imports no
 * `.svelte` file and no browser global, so a CLI, server, or build script can
 * list the presets without a Svelte toolchain. `@happyvertical/smrt-ui/themes`
 * re-exports everything here, so the preset data has exactly one source.
 */

export { glassTheme } from './glass/index.js';
export { happyverticalTheme } from './happyvertical/index.js';
export { materialTheme } from './material/index.js';
export {
  availablePresets,
  getAllThemes,
  getTheme,
  getThemeName,
  getThemeOptions,
  isValidPreset,
  themes,
} from './registry.js';
export { smrtTheme } from './smrt/index.js';
export { studioTheme } from './studio/index.js';
export type {
  ColorPalette,
  ColorScheme,
  ResolvedScheme,
  Theme,
  ThemePreset,
} from './types.js';

import { availablePresets, themes } from './registry.js';
import type { ColorPalette, ThemePreset } from './types.js';

/** A built-in preset reduced to its identity and palettes. */
export interface ThemePresetSummary {
  id: ThemePreset;
  label: string;
  light: ColorPalette;
  dark: ColorPalette;
}

/** Built-in presets in display order: id, label, and light/dark colors. */
export const themePresets: readonly ThemePresetSummary[] = availablePresets.map(
  (id) => ({
    id,
    label: themes[id].name,
    light: themes[id].light,
    dark: themes[id].dark,
  }),
);
