/**
 * SMRT Svelte Themes
 *
 * Unified theme system with Material, Glass, Studio, SMRT, and HappyVertical
 * ("Day Shift") presets.
 * Supports runtime theme switching, dark/light modes, and CSS custom properties.
 *
 * @example
 * ```svelte
 * <script>
 *   import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
 * </script>
 *
 * <ThemeProvider preset="glass" colorScheme="system">
 *   <YourApp />
 * </ThemeProvider>
 * ```
 */

// Theme UI components
export { ColorSchemeToggle, ThemeSwitcher } from './components/index.js';
// Context
export {
  getThemeContext,
  hasThemeContext,
  setThemeContext,
  tryGetThemeContext,
} from './context.svelte.js';
export type { CreateThemeOptions } from './create-theme.js';
// Custom theme creation
export {
  createTheme,
  createThemeFromColor,
  getRegisteredTheme,
  isThemeRegistered,
  preloadThemeRegistry,
  registerTheme,
} from './create-theme.js';
// CSS generation
export {
  generateAllThemesCSS,
  generateThemeCSS,
  generateThemeVariables,
  variablesToStyleString,
} from './css-generator.js';
// Preset data and registry (single source: ./presets.ts, Node-safe)
export {
  availablePresets,
  getAllThemes,
  getTheme,
  getThemeName,
  getThemeOptions,
  glassTheme,
  happyverticalTheme,
  isValidPreset,
  materialTheme,
  smrtTheme,
  studioTheme,
  type ThemePresetSummary,
  themePresets,
  themes,
} from './presets.js';
// Shared tokens (if needed for custom themes)
export {
  appleEasing,
  borderRadiusScale,
  durationScale,
  materialEasing,
  spacingScale,
  studioEasing,
} from './shared.js';
// Main components
export { default as ThemeProvider } from './ThemeProvider.svelte';
// Pre-paint bootstrap script
export { type ThemeScriptOptions, themeScript } from './theme-script.js';
// Types
export type {
  BorderRadius,
  BorderRadiusScale,
  ColorPalette,
  ColorScheme,
  CSSVariableOptions,
  DurationScale,
  EasingScale,
  ElevationScale,
  GlassEffects,
  ResolvedScheme,
  SpacingScale,
  Theme,
  ThemeConfig,
  ThemeContext,
  ThemePreset,
  ThemeState,
  TypographyScale,
  TypographyToken,
} from './types.js';
// Constants
export { defaultThemeConfig } from './types.js';
