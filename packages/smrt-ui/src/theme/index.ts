/**
 * Theme system exports
 */

// Context
export {
  getThemeContext,
  setThemeContext,
  THEME_KEY,
  type ThemeContext,
  type ThemeState,
  tryGetThemeContext,
} from './context.js';
// Components
export { default as ThemeProvider } from './ThemeProvider.svelte';

// Tokens
export {
  borderRadius,
  type ColorScheme,
  darkColors,
  defaultThemeConfig,
  duration,
  easing,
  elevation,
  generateColorVariables,
  generateThemeVariables,
  lightColors,
  spacing,
  type ThemeConfig,
  typography,
} from './tokens.js';
