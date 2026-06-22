/**
 * Theme context for sharing theme state across components
 */

import { getContext, setContext } from 'svelte';
import type { ColorScheme, ThemeConfig } from './tokens.js';

/**
 * Theme context key
 */
export const THEME_KEY = Symbol('smrt-theme');

/**
 * Theme state interface
 */
export interface ThemeState {
  /** Current color scheme */
  colorScheme: ColorScheme;
  /** Resolved color scheme (never 'system') */
  resolvedScheme: 'light' | 'dark';
  /** Whether dark mode is active */
  isDark: boolean;
  /** Full theme configuration */
  config: ThemeConfig;
}

/**
 * Theme context interface with methods
 */
export interface ThemeContext {
  /** Current theme state */
  state: ThemeState;
  /** Set color scheme preference */
  setColorScheme: (scheme: ColorScheme) => void;
  /** Toggle between light and dark */
  toggleColorScheme: () => void;
  /** Update theme configuration */
  updateConfig: (config: Partial<ThemeConfig>) => void;
}

/**
 * Set theme context (used by ThemeProvider)
 */
export function setThemeContext(context: ThemeContext): void {
  setContext(THEME_KEY, context);
}

/**
 * Get theme context
 * @throws If called outside of ThemeProvider
 */
export function getThemeContext(): ThemeContext {
  const context = getContext<ThemeContext>(THEME_KEY);

  if (!context) {
    throw new Error(
      'Theme context not found. Make sure to wrap your app with <ThemeProvider>',
    );
  }

  return context;
}

/**
 * Try to get theme context
 * Returns null if not available (doesn't throw)
 */
export function tryGetThemeContext(): ThemeContext | null {
  return getContext<ThemeContext>(THEME_KEY) ?? null;
}
