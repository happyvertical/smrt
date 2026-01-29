/**
 * CSS Variable Generator
 *
 * Converts theme definitions into CSS custom properties for runtime theming.
 * Generates CSS variables for colors, typography, spacing, elevation, etc.
 */

import type {
  BorderRadiusScale,
  ColorPalette,
  DurationScale,
  EasingScale,
  ElevationScale,
  GlassEffects,
  SpacingScale,
  Theme,
  TypographyScale,
} from './types.js';

/**
 * CSS variable generation options
 */
export interface GenerateCSSOptions {
  /** CSS variable prefix (default: --smrt) */
  prefix?: string;
  /** Include theme ID as data attribute selector */
  includeDataAttr?: boolean;
}

/**
 * Generate CSS custom properties from a color palette
 */
function generateColorVariables(
  colors: ColorPalette,
  prefix: string,
): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const [key, value] of Object.entries(colors)) {
    // Convert camelCase to kebab-case: primaryContainer -> primary-container
    const cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
    vars[`${prefix}-color-${cssKey}`] = value;
  }

  return vars;
}

/**
 * Generate CSS custom properties from typography scale
 */
function generateTypographyVariables(
  typography: TypographyScale,
  prefix: string,
): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const [key, token] of Object.entries(typography)) {
    const cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
    vars[`${prefix}-typography-${cssKey}-size`] = token.size;
    vars[`${prefix}-typography-${cssKey}-line-height`] = token.lineHeight;
    vars[`${prefix}-typography-${cssKey}-weight`] = String(token.weight);
    vars[`${prefix}-typography-${cssKey}-tracking`] = token.tracking;
    if (token.fontFamily) {
      vars[`${prefix}-typography-${cssKey}-font-family`] = token.fontFamily;
    }
  }

  return vars;
}

/**
 * Generate CSS custom properties from spacing scale
 */
function generateSpacingVariables(
  spacing: SpacingScale,
  prefix: string,
): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const [key, value] of Object.entries(spacing)) {
    // Handle decimal keys like "0.5"
    const cssKey = key.replace('.', '_');
    vars[`${prefix}-spacing-${cssKey}`] = value;
  }

  return vars;
}

/**
 * Generate CSS custom properties from border radius scale
 */
function generateBorderRadiusVariables(
  borderRadius: BorderRadiusScale,
  prefix: string,
): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const [key, value] of Object.entries(borderRadius)) {
    const cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
    vars[`${prefix}-radius-${cssKey}`] = value;
  }

  return vars;
}

/**
 * Generate CSS custom properties from elevation scale
 */
function generateElevationVariables(
  elevation: ElevationScale,
  prefix: string,
): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const [key, value] of Object.entries(elevation)) {
    vars[`${prefix}-elevation-${key}`] = value;
  }

  return vars;
}

/**
 * Generate CSS custom properties from duration scale
 */
function generateDurationVariables(
  duration: DurationScale,
  prefix: string,
): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const [key, value] of Object.entries(duration)) {
    const cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
    vars[`${prefix}-duration-${cssKey}`] = value;
  }

  return vars;
}

/**
 * Generate CSS custom properties from easing scale
 */
function generateEasingVariables(
  easing: EasingScale,
  prefix: string,
): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const [key, value] of Object.entries(easing)) {
    const cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
    vars[`${prefix}-easing-${cssKey}`] = value;
  }

  return vars;
}

/**
 * Generate CSS custom properties for glass effects
 */
function generateGlassVariables(
  glass: GlassEffects | undefined,
  prefix: string,
): Record<string, string> {
  if (!glass) return {};

  return {
    [`${prefix}-glass-blur`]: glass.blur,
    [`${prefix}-glass-saturation`]: glass.saturation,
    [`${prefix}-glass-border-opacity`]: glass.borderOpacity,
    [`${prefix}-glass-background-opacity`]: glass.backgroundOpacity,
  };
}

/**
 * Generate all CSS custom properties for a theme
 * @param theme - Theme definition
 * @param isDark - Whether to use dark mode colors
 * @param options - Generation options
 * @returns Object with CSS variable names and values
 */
export function generateThemeVariables(
  theme: Theme,
  isDark: boolean,
  options: GenerateCSSOptions = {},
): Record<string, string> {
  const { prefix = '--smrt' } = options;
  const colors = isDark ? theme.dark : theme.light;

  return {
    // Theme identification
    [`${prefix}-theme-id`]: theme.id,
    [`${prefix}-theme-name`]: theme.name,
    [`${prefix}-color-scheme`]: isDark ? 'dark' : 'light',
    [`${prefix}-font-family`]: theme.fontFamily,

    // Colors
    ...generateColorVariables(colors, prefix),

    // Typography
    ...generateTypographyVariables(theme.typography, prefix),

    // Spacing
    ...generateSpacingVariables(theme.spacing, prefix),

    // Border radius
    ...generateBorderRadiusVariables(theme.borderRadius, prefix),

    // Elevation
    ...generateElevationVariables(theme.elevation, prefix),

    // Duration
    ...generateDurationVariables(theme.duration, prefix),

    // Easing
    ...generateEasingVariables(theme.easing, prefix),

    // Glass effects (if present)
    ...generateGlassVariables(theme.glass, prefix),
  };
}

/**
 * Convert variables object to CSS style string
 * @param variables - Record of CSS variable names and values
 * @returns CSS string for style attribute
 */
export function variablesToStyleString(
  variables: Record<string, string>,
): string {
  return Object.entries(variables)
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ');
}

/**
 * Generate CSS class content for a theme
 * @param theme - Theme definition
 * @param isDark - Whether to use dark mode
 * @param options - Generation options
 * @returns CSS string for embedding in a <style> tag
 */
export function generateThemeCSS(
  theme: Theme,
  isDark: boolean,
  options: GenerateCSSOptions = {},
): string {
  const { prefix = '--smrt', includeDataAttr = true } = options;
  const variables = generateThemeVariables(theme, isDark, { prefix });
  const varDeclarations = Object.entries(variables)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n');

  if (includeDataAttr) {
    const scheme = isDark ? 'dark' : 'light';
    return `[data-theme="${theme.id}"][data-color-scheme="${scheme}"] {\n${varDeclarations}\n}`;
  }

  return `:root {\n${varDeclarations}\n}`;
}

/**
 * Generate all theme CSS for all presets and modes
 * @returns Complete CSS for all themes
 */
export function generateAllThemesCSS(): string {
  const { themes } = require('./registry.js');
  const cssParts: string[] = [];

  for (const theme of Object.values<Theme>(themes)) {
    cssParts.push(generateThemeCSS(theme, false, { includeDataAttr: true }));
    cssParts.push(generateThemeCSS(theme, true, { includeDataAttr: true }));
  }

  return cssParts.join('\n\n');
}
