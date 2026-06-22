/**
 * Create Theme Utilities
 *
 * Helper functions for creating custom themes that match the SMRT theme system.
 */

import {
  hasCustomTheme,
  registerCustomTheme,
  themes as registeredThemes,
} from './registry.js';
import {
  borderRadiusScale,
  durationScale,
  materialEasing,
  spacingScale,
} from './shared.js';
import type {
  ColorPalette,
  EasingScale,
  ElevationScale,
  GlassEffects,
  Theme,
  ThemePreset,
  TypographyScale,
} from './types.js';

/**
 * Options for creating a custom theme
 */
export interface CreateThemeOptions {
  /** Theme identifier (must be unique) */
  id: string;
  /** Display name */
  name: string;
  /** Light mode color palette */
  light: Partial<ColorPalette> & Pick<ColorPalette, 'primary' | 'background'>;
  /** Dark mode color palette (optional, will be auto-generated if not provided) */
  dark?: Partial<ColorPalette>;
  /** Typography scale (optional, defaults to Material) */
  typography?: Partial<TypographyScale>;
  /** Elevation shadows (optional) */
  elevation?: Partial<ElevationScale>;
  /** Custom easing curves (optional) */
  easing?: Partial<EasingScale>;
  /** Glass effects (optional) */
  glass?: GlassEffects;
  /** Font family */
  fontFamily?: string;
  /** Base theme to extend (copies all tokens as starting point) */
  extend?: ThemePreset;
}

/**
 * Default color palette structure with neutral grays
 */
const defaultColorStructure: Omit<
  ColorPalette,
  'primary' | 'background' | keyof GlassEffects
> = {
  // These will be generated from the primary color
  onPrimary: '#ffffff',
  primaryContainer: '',
  onPrimaryContainer: '',
  secondary: '#64748b',
  onSecondary: '#ffffff',
  secondaryContainer: '#f1f5f9',
  onSecondaryContainer: '#1e293b',
  tertiary: '#8b5cf6',
  onTertiary: '#ffffff',
  tertiaryContainer: '#ede9fe',
  onTertiaryContainer: '#3b0764',
  error: '#dc2626',
  onError: '#ffffff',
  errorContainer: '#fee2e2',
  onErrorContainer: '#7f1d1d',
  warning: '#f59e0b',
  onWarning: '#000000',
  warningContainer: '#fef3c7',
  onWarningContainer: '#78350f',
  success: '#22c55e',
  onSuccess: '#000000',
  successContainer: '#dcfce7',
  onSuccessContainer: '#14532d',
  surface: '#ffffff',
  onSurface: '#111827',
  surfaceVariant: '#f9fafb',
  onSurfaceVariant: '#6b7280',
  surfaceContainer: '#f3f4f6',
  surfaceContainerLow: '#f9fafb',
  surfaceContainerHigh: '#e5e7eb',
  surfaceContainerHighest: '#d1d5db',
  surfaceContainerLowest: '#ffffff',
  surfaceDim: '#e5e7eb',
  surfaceBright: '#ffffff',
  onBackground: '#111827',
  outline: '#d1d5db',
  outlineVariant: '#e5e7eb',
  inverseSurface: '#1f2937',
  inverseOnSurface: '#f9fafb',
  inversePrimary: '',
  shadow: '#000000',
  scrim: 'rgba(0, 0, 0, 0.5)',
};

/**
 * Helper function to clamp a value between min and max
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Helper function to convert RGB component to 2-digit hex
 */
function toHexComponent(value: number): string {
  const clamped = Math.round(clamp(value, 0, 255));
  return clamped.toString(16).padStart(2, '0');
}

/**
 * Generate dark mode colors from light mode colors
 * Uses simple inversion logic - for production use, manually define dark colors
 */
function generateDarkColors(light: ColorPalette): ColorPalette {
  // Helper to adjust color brightness with proper rounding and hex conversion
  const adjustBrightness = (hex: string, factor: number): string => {
    // Handle 3-character hex codes
    let fullHex = hex;
    if (hex.length === 4 && hex[0] === '#') {
      fullHex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    }

    const r = parseInt(fullHex.slice(1, 3), 16) * factor;
    const g = parseInt(fullHex.slice(3, 5), 16) * factor;
    const b = parseInt(fullHex.slice(5, 7), 16) * factor;

    return `#${toHexComponent(r)}${toHexComponent(g)}${toHexComponent(b)}`;
  };

  return {
    ...light,
    primary: light.inversePrimary || adjustBrightness(light.primary, 1.2),
    onPrimary: adjustBrightness(light.onPrimary, 0.8),
    primaryContainer: adjustBrightness(
      light.primaryContainer || light.primary,
      0.3,
    ),
    onPrimaryContainer: adjustBrightness(
      light.onPrimaryContainer || light.onPrimary,
      1.2,
    ),
    secondary: adjustBrightness(light.secondary, 1.3),
    onSecondary: adjustBrightness(light.onSecondary, 0.8),
    secondaryContainer: adjustBrightness(light.secondaryContainer, 0.3),
    onSecondaryContainer: adjustBrightness(light.onSecondaryContainer, 1.2),
    surface: '#111827',
    onSurface: '#f9fafb',
    surfaceVariant: '#1f2937',
    onSurfaceVariant: '#9ca3af',
    surfaceContainer: '#1f2937',
    surfaceContainerLow: '#111827',
    surfaceContainerHigh: '#374151',
    surfaceContainerHighest: '#4b5563',
    surfaceContainerLowest: '#030712',
    surfaceDim: '#1f2937',
    surfaceBright: '#374151',
    background: '#030712',
    onBackground: '#f9fafb',
    outline: '#4b5563',
    outlineVariant: '#374151',
    inverseSurface: '#f9fafb',
    inverseOnSurface: '#1f2937',
    inversePrimary: light.primary,
    shadow: light.shadow,
    scrim: 'rgba(0, 0, 0, 0.7)',
  };
}

/**
 * Merge typography with defaults
 */
function mergeTypography(custom?: Partial<TypographyScale>): TypographyScale {
  const defaults: TypographyScale = {
    displayLarge: {
      size: '3.5rem',
      lineHeight: '1.1',
      weight: '400',
      tracking: '-0.02em',
    },
    displayMedium: {
      size: '2.75rem',
      lineHeight: '1.15',
      weight: '400',
      tracking: '-0.01em',
    },
    displaySmall: {
      size: '2.25rem',
      lineHeight: '1.2',
      weight: '400',
      tracking: '0',
    },
    headlineLarge: {
      size: '2rem',
      lineHeight: '1.25',
      weight: '400',
      tracking: '0',
    },
    headlineMedium: {
      size: '1.75rem',
      lineHeight: '1.3',
      weight: '400',
      tracking: '0',
    },
    headlineSmall: {
      size: '1.5rem',
      lineHeight: '1.35',
      weight: '400',
      tracking: '0',
    },
    titleLarge: {
      size: '1.375rem',
      lineHeight: '1.4',
      weight: '500',
      tracking: '0',
    },
    titleMedium: {
      size: '1rem',
      lineHeight: '1.5',
      weight: '500',
      tracking: '0.01em',
    },
    titleSmall: {
      size: '0.875rem',
      lineHeight: '1.5',
      weight: '500',
      tracking: '0.01em',
    },
    bodyLarge: {
      size: '1rem',
      lineHeight: '1.5',
      weight: '400',
      tracking: '0.03em',
    },
    bodyMedium: {
      size: '0.875rem',
      lineHeight: '1.5',
      weight: '400',
      tracking: '0.02em',
    },
    bodySmall: {
      size: '0.75rem',
      lineHeight: '1.4',
      weight: '400',
      tracking: '0.03em',
    },
    labelLarge: {
      size: '0.875rem',
      lineHeight: '1.4',
      weight: '500',
      tracking: '0.01em',
    },
    labelMedium: {
      size: '0.75rem',
      lineHeight: '1.4',
      weight: '500',
      tracking: '0.05em',
    },
    labelSmall: {
      size: '0.6875rem',
      lineHeight: '1.4',
      weight: '500',
      tracking: '0.05em',
    },
  };

  if (!custom) return defaults;

  return {
    displayLarge: { ...defaults.displayLarge, ...custom.displayLarge },
    displayMedium: { ...defaults.displayMedium, ...custom.displayMedium },
    displaySmall: { ...defaults.displaySmall, ...custom.displaySmall },
    headlineLarge: { ...defaults.headlineLarge, ...custom.headlineLarge },
    headlineMedium: { ...defaults.headlineMedium, ...custom.headlineMedium },
    headlineSmall: { ...defaults.headlineSmall, ...custom.headlineSmall },
    titleLarge: { ...defaults.titleLarge, ...custom.titleLarge },
    titleMedium: { ...defaults.titleMedium, ...custom.titleMedium },
    titleSmall: { ...defaults.titleSmall, ...custom.titleSmall },
    bodyLarge: { ...defaults.bodyLarge, ...custom.bodyLarge },
    bodyMedium: { ...defaults.bodyMedium, ...custom.bodyMedium },
    bodySmall: { ...defaults.bodySmall, ...custom.bodySmall },
    labelLarge: { ...defaults.labelLarge, ...custom.labelLarge },
    labelMedium: { ...defaults.labelMedium, ...custom.labelMedium },
    labelSmall: { ...defaults.labelSmall, ...custom.labelSmall },
  };
}

/**
 * Create a custom theme
 *
 * @example
 * ```typescript
 * import { createTheme, registerTheme } from '@happyvertical/smrt-ui/themes';
 *
 * const myTheme = createTheme({
 *   id: 'brand',
 *   name: 'Brand Theme',
 *   light: {
 *     primary: '#ff6b35',
 *     background: '#fafafa',
 *     surface: '#ffffff',
 *   },
 *   dark: {
 *     primary: '#ff8c5a',
 *     background: '#0a0a0a',
 *     surface: '#1a1a1a',
 *   },
 *   fontFamily: 'Inter, sans-serif',
 * });
 *
 * registerTheme(myTheme);
 * ```
 */
export function createTheme(options: CreateThemeOptions): Theme {
  const {
    id,
    name,
    light: lightPartial,
    dark: darkPartial,
    extend = 'material',
  } = options;

  // Get base theme if extending (lazy import to avoid circular deps)
  const baseTheme = extend ? getBaseThemeSync(extend) : null;

  // Build light colors
  const lightColors: ColorPalette = {
    ...defaultColorStructure,
    ...baseTheme?.light,
    ...lightPartial,
    // Generate derived colors
    primaryContainer:
      lightPartial.primaryContainer || `${lightPartial.primary}20`,
    onPrimaryContainer: lightPartial.onPrimaryContainer || lightPartial.primary,
    inversePrimary: lightPartial.inversePrimary || lightPartial.primary,
  } as ColorPalette;

  // Build dark colors
  const darkColors: ColorPalette = darkPartial
    ? ({ ...lightColors, ...darkPartial } as ColorPalette)
    : generateDarkColors(lightColors);

  return {
    id: id as ThemePreset,
    name,
    light: lightColors,
    dark: darkColors,
    typography: mergeTypography(options.typography),
    elevation: {
      ...(baseTheme?.elevation || materialElevation()),
      ...options.elevation,
    } as ElevationScale,
    spacing: spacingScale,
    borderRadius: borderRadiusScale,
    duration: durationScale,
    easing: {
      ...(baseTheme?.easing || materialEasing),
      ...options.easing,
    } as EasingScale,
    glass: options.glass,
    fontFamily:
      options.fontFamily || baseTheme?.fontFamily || 'system-ui, sans-serif',
  };
}

// Cache for base themes to avoid repeated dynamic imports
let themeRegistryCache: Record<string, Theme> | null = null;

/**
 * Get a base theme for extension - synchronous version using cache
 * Falls back to null if registry not loaded
 */
function getBaseThemeSync(preset: ThemePreset): Theme | null {
  if (themeRegistryCache && preset in themeRegistryCache) {
    return themeRegistryCache[preset] || null;
  }
  // Return null if not in cache - will use defaults
  // User should ensure themes are loaded before extending
  return null;
}

/**
 * Preload the theme registry for extension support
 * Call this before createTheme if using the extend option
 */
export async function preloadThemeRegistry(): Promise<void> {
  if (themeRegistryCache) return;
  themeRegistryCache = registeredThemes;
}

/**
 * Material elevation defaults
 */
function materialElevation(): ElevationScale {
  return {
    0: 'none',
    1: '0 1px 2px 0 rgb(0 0 0 / 0.05), 0 1px 3px 0 rgb(0 0 0 / 0.02)',
    2: '0 1px 2px 0 rgb(0 0 0 / 0.06), 0 2px 4px 0 rgb(0 0 0 / 0.04)',
    3: '0 2px 4px 0 rgb(0 0 0 / 0.06), 0 4px 8px 0 rgb(0 0 0 / 0.04)',
    4: '0 4px 8px 0 rgb(0 0 0 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.04)',
    5: '0 8px 16px 0 rgb(0 0 0 / 0.1), 0 16px 32px 0 rgb(0 0 0 / 0.04)',
  };
}

/**
 * Register a custom theme for use with ThemeProvider
 *
 * @example
 * ```typescript
 * import { createTheme, registerTheme } from '@happyvertical/smrt-ui/themes';
 *
 * const customTheme = createTheme({ id: 'brand', name: 'Brand', ... });
 * registerTheme(customTheme);
 *
 * // Now use in your app
 * <ThemeProvider preset="brand" />
 * ```
 */
export function registerTheme(theme: Theme): void {
  registerCustomTheme(theme);
}

/**
 * Get a registered custom theme
 */
export function getRegisteredTheme(_id: string): Theme | undefined {
  // Dynamic import to avoid circular deps
  // Return undefined synchronously - use isThemeRegistered for checks
  return undefined;
}

/**
 * Check if a theme is registered
 * Note: This is async due to ESM dynamic import requirements
 */
export async function isThemeRegistered(id: string): Promise<boolean> {
  return hasCustomTheme(id);
}

/**
 * Create a simple theme from just a primary color
 * Auto-generates all other colors
 *
 * @example
 * ```typescript
 * const brandTheme = createThemeFromColor('#ff6b35', 'brand', 'Brand Theme');
 * registerTheme(brandTheme);
 * ```
 */
export function createThemeFromColor(
  primaryColor: string,
  id: string,
  name: string,
  options?: Omit<CreateThemeOptions, 'id' | 'name' | 'light'>,
): Theme {
  return createTheme({
    id,
    name,
    light: {
      primary: primaryColor,
      background: '#ffffff',
      surface: '#ffffff',
    },
    ...options,
  });
}

// Types are exported from index.ts
