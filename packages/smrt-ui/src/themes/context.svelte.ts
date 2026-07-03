/**
 * Theme Context
 *
 * Svelte 5 runes-based context for theme state management.
 * Provides reactive theme state and methods to all child components.
 */

import { getContext, setContext } from 'svelte';
import type {
  ColorScheme,
  ThemeConfig,
  ThemeContext,
  ThemePreset,
} from './types.js';

/** Context key symbol */
const THEME_CONTEXT_KEY = Symbol('smrt-theme-context');

/**
 * Set the theme context in the component tree
 * @param context - Theme context object
 */
export function setThemeContext(context: ThemeContext): void {
  setContext(THEME_CONTEXT_KEY, context);
}

/**
 * Get the theme context from the component tree
 * @returns Theme context
 * @throws Error if called outside of ThemeProvider
 */
export function getThemeContext(): ThemeContext {
  const context = getContext<ThemeContext>(THEME_CONTEXT_KEY);

  if (!context) {
    throw new Error(
      'Theme context not found. Make sure to wrap your app with <ThemeProvider> from @smrt/svelte/themes',
    );
  }

  return context;
}

/**
 * Try to get the theme context without throwing
 * @returns Theme context or null if not available
 */
export function tryGetThemeContext(): ThemeContext | null {
  return getContext<ThemeContext>(THEME_CONTEXT_KEY) ?? null;
}

/**
 * Check if theme context is available
 * @returns True if inside ThemeProvider
 */
export function hasThemeContext(): boolean {
  return !!tryGetThemeContext();
}

// Re-export types for convenience
export type { ColorScheme, ThemeConfig, ThemeContext, ThemePreset };
