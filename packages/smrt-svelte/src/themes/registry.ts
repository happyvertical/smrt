/**
 * Theme Registry
 *
 * Central registry for all available themes. Provides utilities for
 * theme lookup, validation, and management.
 */

import { glassTheme } from './glass/index.js';
import { materialTheme } from './material/index.js';
import { studioTheme } from './studio/index.js';
import type { Theme, ThemePreset } from './types.js';

/**
 * Map of all registered themes
 */
export const themes: Record<ThemePreset, Theme> = {
  material: materialTheme,
  glass: glassTheme,
  studio: studioTheme,
};

/**
 * List of available theme presets
 */
export const availablePresets: ThemePreset[] = ['material', 'glass', 'studio'];

/**
 * Get a theme by preset name
 * @param preset - Theme preset identifier
 * @returns The theme definition
 * @throws Error if preset is invalid
 */
export function getTheme(preset: ThemePreset): Theme {
  const theme = themes[preset];
  if (!theme) {
    throw new Error(
      `Unknown theme preset: ${preset}. Available: ${availablePresets.join(', ')}`,
    );
  }
  return theme;
}

/**
 * Check if a preset is valid
 * @param preset - Value to check
 * @returns True if valid theme preset
 */
export function isValidPreset(preset: string): preset is ThemePreset {
  return availablePresets.includes(preset as ThemePreset);
}

/**
 * Get theme display name
 * @param preset - Theme preset
 * @returns Human-readable theme name
 */
export function getThemeName(preset: ThemePreset): string {
  return themes[preset]?.name ?? preset;
}

/**
 * Get all themes as array
 * @returns Array of theme definitions
 */
export function getAllThemes(): Theme[] {
  return Object.values(themes);
}

/**
 * Get theme options for UI selection
 * @returns Array of {value, label} objects
 */
export function getThemeOptions(): { value: ThemePreset; label: string }[] {
  return availablePresets.map((preset) => ({
    value: preset,
    label: themes[preset].name,
  }));
}
