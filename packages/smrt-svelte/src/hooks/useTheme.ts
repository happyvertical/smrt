/**
 * Hook for accessing theme context
 */

import {
  getThemeContext,
  type ThemeContext,
  tryGetThemeContext,
} from '@happyvertical/smrt-ui/theme';

/**
 * Get theme context (throws if not available)
 */
export function useTheme(): ThemeContext {
  return getThemeContext();
}

/**
 * Try to get theme context (returns null if not available)
 */
export function useTryTheme(): ThemeContext | null {
  return tryGetThemeContext();
}
