/**
 * Theme Registry
 *
 * Central registry for all available themes. Provides utilities for
 * theme lookup, validation, and management.
 */

import { glassTheme } from './glass/index.js';
import { materialTheme } from './material/index.js';
import { smrtTheme } from './smrt/index.js';
import { studioTheme } from './studio/index.js';
import type { Theme, ThemePreset } from './types.js';

/**
 * Map of all built-in themes
 */
export const themes: Record<ThemePreset, Theme> = {
  material: materialTheme,
  glass: glassTheme,
  studio: studioTheme,
  smrt: smrtTheme,
};

/**
 * List of available theme presets (built-in only)
 */
export const availablePresets: ThemePreset[] = [
  'material',
  'glass',
  'studio',
  'smrt',
];

/**
 * Get a theme by preset name
 * Checks built-in themes first, then custom registered themes
 * @param preset - Theme preset identifier
 * @returns The theme definition
 * @throws Error if preset is invalid
 */
export function getTheme(preset: ThemePreset): Theme {
  // Check built-in themes first
  const builtInTheme = themes[preset];
  if (builtInTheme) {
    return builtInTheme;
  }

  // Check custom themes (imported dynamically to avoid circular deps)
  // This will be populated by registerTheme from create-theme.ts
  const customTheme = getCustomTheme(preset);
  if (customTheme) {
    return customTheme;
  }

  throw new Error(
    `Unknown theme preset: ${preset}. Available: ${getAllPresetNames().join(', ')}`,
  );
}

/**
 * Check if a preset is valid (built-in or custom)
 * @param preset - Value to check
 * @returns True if valid theme preset
 */
export function isValidPreset(preset: string): preset is ThemePreset {
  return (
    availablePresets.includes(preset as ThemePreset) || hasCustomTheme(preset)
  );
}

/**
 * Get theme display name
 * @param preset - Theme preset
 * @returns Human-readable theme name
 */
export function getThemeName(preset: ThemePreset): string {
  const theme = themes[preset];
  if (theme) return theme.name;

  const customTheme = getCustomTheme(preset);
  return customTheme?.name ?? preset;
}

/**
 * Get all themes as array (built-in only)
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
  const builtInOptions = availablePresets.map((preset) => ({
    value: preset,
    label: themes[preset].name,
  }));

  const customOptions = getCustomThemeOptions();

  return [...builtInOptions, ...customOptions];
}

// --- Custom Theme Support ---

// WeakMap to store custom themes without polluting module scope
const customThemeRegistry = new Map<string, Theme>();

/**
 * Register a custom theme in the registry
 * @internal Use registerTheme from create-theme.ts instead
 */
export function registerCustomTheme(theme: Theme): void {
  customThemeRegistry.set(theme.id, theme);
}

/**
 * Get a custom theme by id
 * @internal
 */
export function getCustomTheme(id: string): Theme | undefined {
  return customThemeRegistry.get(id);
}

/**
 * Check if a custom theme is registered
 * @internal
 */
export function hasCustomTheme(id: string): boolean {
  return customThemeRegistry.has(id);
}

/**
 * Get all custom theme options for UI
 * @internal
 */
function getCustomThemeOptions(): { value: ThemePreset; label: string }[] {
  return Array.from(customThemeRegistry.entries()).map(([id, theme]) => ({
    value: id as ThemePreset,
    label: theme.name,
  }));
}

/**
 * Get all preset names including custom themes
 * @internal
 */
function getAllPresetNames(): string[] {
  return [...availablePresets, ...customThemeRegistry.keys()];
}
