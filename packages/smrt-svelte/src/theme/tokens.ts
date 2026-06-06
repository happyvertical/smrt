/**
 * Material 3 Design Tokens
 *
 * Based on Material Design 3 color system with semantic tokens
 * for consistent theming across components.
 *
 * NOTE: this is the simple/legacy `src/theme/` ThemeProvider. The canonical
 * full token surface (spacing + typography included) lives in the preset
 * system under `src/themes/` (Material/Glass/Studio + css-generator.ts). The
 * additive Material-3 aliases (issue #1431) are imported from the shared
 * preset tokens so both providers stay in lock-step where their categories
 * overlap.
 */

import {
  borderRadiusAliases,
  durationAliases,
  fontFamilyAliases,
  fontWeightTokens,
  zIndexTokens,
} from '../themes/shared.js';

/**
 * Color scheme type
 */
export type ColorScheme = 'light' | 'dark' | 'system';

/**
 * Theme configuration
 */
export interface ThemeConfig {
  /** Color scheme preference */
  colorScheme: ColorScheme;
  /** Primary color (hex) */
  primaryColor?: string;
  /** Border radius scale */
  borderRadius?: 'none' | 'sm' | 'md' | 'lg' | 'full';
  /** Custom CSS variables to override */
  overrides?: Record<string, string>;
}

/**
 * Default theme configuration
 */
export const defaultThemeConfig: ThemeConfig = {
  colorScheme: 'system',
  primaryColor: '#3b82f6', // Blue-500
  borderRadius: 'md',
};

/**
 * Material 3 color palette
 * Light theme semantic colors
 */
export const lightColors = {
  // Primary
  primary: '#3b82f6',
  onPrimary: '#ffffff',
  primaryContainer: '#dbeafe',
  onPrimaryContainer: '#1e3a5f',

  // Secondary
  secondary: '#64748b',
  onSecondary: '#ffffff',
  secondaryContainer: '#f1f5f9',
  onSecondaryContainer: '#1e293b',

  // Tertiary
  tertiary: '#8b5cf6',
  onTertiary: '#ffffff',
  tertiaryContainer: '#ede9fe',
  onTertiaryContainer: '#3b0764',

  // Error
  error: '#dc2626',
  onError: '#ffffff',
  errorContainer: '#fee2e2',
  onErrorContainer: '#7f1d1d',

  // Warning
  warning: '#f59e0b',
  onWarning: '#ffffff',
  warningContainer: '#fef3c7',
  onWarningContainer: '#78350f',

  // Success
  success: '#22c55e',
  onSuccess: '#ffffff',
  successContainer: '#dcfce7',
  onSuccessContainer: '#14532d',

  // Surface
  surface: '#ffffff',
  onSurface: '#111827',
  surfaceVariant: '#f9fafb',
  onSurfaceVariant: '#6b7280',
  surfaceContainer: '#f3f4f6',
  surfaceContainerLow: '#f9fafb',
  surfaceContainerHigh: '#e5e7eb',

  // Outline
  outline: '#d1d5db',
  outlineVariant: '#e5e7eb',

  // Background
  background: '#ffffff',
  onBackground: '#111827',

  // Inverse
  inverseSurface: '#1f2937',
  inverseOnSurface: '#f9fafb',
  inversePrimary: '#93c5fd',

  // Scrim
  scrim: 'rgba(0, 0, 0, 0.5)',
};

/**
 * Material 3 color palette
 * Dark theme semantic colors
 */
export const darkColors = {
  // Primary
  primary: '#60a5fa',
  onPrimary: '#1e3a5f',
  primaryContainer: '#1e40af',
  onPrimaryContainer: '#dbeafe',

  // Secondary
  secondary: '#94a3b8',
  onSecondary: '#1e293b',
  secondaryContainer: '#334155',
  onSecondaryContainer: '#f1f5f9',

  // Tertiary
  tertiary: '#a78bfa',
  onTertiary: '#3b0764',
  tertiaryContainer: '#5b21b6',
  onTertiaryContainer: '#ede9fe',

  // Error
  error: '#f87171',
  onError: '#7f1d1d',
  errorContainer: '#991b1b',
  onErrorContainer: '#fee2e2',

  // Warning
  warning: '#fbbf24',
  onWarning: '#78350f',
  warningContainer: '#92400e',
  onWarningContainer: '#fef3c7',

  // Success
  success: '#4ade80',
  onSuccess: '#14532d',
  successContainer: '#166534',
  onSuccessContainer: '#dcfce7',

  // Surface
  surface: '#111827',
  onSurface: '#f9fafb',
  surfaceVariant: '#1f2937',
  onSurfaceVariant: '#9ca3af',
  surfaceContainer: '#1f2937',
  surfaceContainerLow: '#111827',
  surfaceContainerHigh: '#374151',

  // Outline
  outline: '#4b5563',
  outlineVariant: '#374151',

  // Background
  background: '#030712',
  onBackground: '#f9fafb',

  // Inverse
  inverseSurface: '#f9fafb',
  inverseOnSurface: '#1f2937',
  inversePrimary: '#2563eb',

  // Scrim
  scrim: 'rgba(0, 0, 0, 0.7)',
};

/**
 * Typography scale
 */
export const typography = {
  // Display
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

  // Headline
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

  // Title
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

  // Body
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

  // Label
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

/**
 * Spacing scale (in rem)
 */
export const spacing = {
  0: '0',
  0.5: '0.125rem',
  1: '0.25rem',
  1.5: '0.375rem',
  2: '0.5rem',
  2.5: '0.625rem',
  3: '0.75rem',
  3.5: '0.875rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  7: '1.75rem',
  8: '2rem',
  9: '2.25rem',
  10: '2.5rem',
  11: '2.75rem',
  12: '3rem',
  14: '3.5rem',
  16: '4rem',
  20: '5rem',
  24: '6rem',
};

/**
 * Border radius scale
 */
export const borderRadius = {
  none: '0',
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
  '2xl': '1.5rem',
  '3xl': '2rem',
  full: '9999px',
};

/**
 * Shadow elevation scale (Material 3 style)
 */
export const elevation = {
  0: 'none',
  1: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  2: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  3: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  4: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  5: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
};

/**
 * Transition durations
 */
export const duration = {
  instant: '0ms',
  fast: '100ms',
  normal: '200ms',
  slow: '300ms',
  slower: '500ms',
};

/**
 * Transition easings (Material 3 style)
 */
export const easing = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  standardDecelerate: 'cubic-bezier(0, 0, 0, 1)',
  standardAccelerate: 'cubic-bezier(0.3, 0, 1, 1)',
  emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
  emphasizedDecelerate: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  emphasizedAccelerate: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
};

/**
 * Generate CSS custom properties from colors
 */
export function generateColorVariables(
  colors: typeof lightColors,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors)) {
    const cssKey = `--smrt-color-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
    vars[cssKey] = value;
  }
  return vars;
}

/**
 * Generate all CSS custom properties for a theme
 */
export function generateThemeVariables(
  isDark: boolean,
): Record<string, string> {
  const colors = isDark ? darkColors : lightColors;
  const colorVars = generateColorVariables(colors);

  const vars: Record<string, string> = {
    ...colorVars,
    // Border radius
    '--smrt-radius-none': borderRadius.none,
    '--smrt-radius-sm': borderRadius.sm,
    '--smrt-radius-md': borderRadius.md,
    '--smrt-radius-lg': borderRadius.lg,
    '--smrt-radius-xl': borderRadius.xl,
    '--smrt-radius-2xl': borderRadius['2xl'],
    '--smrt-radius-3xl': borderRadius['3xl'],
    '--smrt-radius-full': borderRadius.full,
    // Elevation
    '--smrt-elevation-0': elevation[0],
    '--smrt-elevation-1': elevation[1],
    '--smrt-elevation-2': elevation[2],
    '--smrt-elevation-3': elevation[3],
    '--smrt-elevation-4': elevation[4],
    '--smrt-elevation-5': elevation[5],
    // Duration
    '--smrt-duration-instant': duration.instant,
    '--smrt-duration-fast': duration.fast,
    '--smrt-duration-normal': duration.normal,
    '--smrt-duration-slow': duration.slow,
    '--smrt-duration-slower': duration.slower,
    // Easing
    '--smrt-easing-standard': easing.standard,
    '--smrt-easing-standard-decelerate': easing.standardDecelerate,
    '--smrt-easing-standard-accelerate': easing.standardAccelerate,
    '--smrt-easing-emphasized': easing.emphasized,
    '--smrt-easing-emphasized-decelerate': easing.emphasizedDecelerate,
    '--smrt-easing-emphasized-accelerate': easing.emphasizedAccelerate,
  };

  // Additive Material-3 aliases + theme-independent helper tokens (#1431),
  // mirroring the preset system so both providers expose the same vocabulary.
  for (const [alias, scaleKey] of Object.entries(borderRadiusAliases)) {
    vars[`--smrt-radius-${alias}`] = borderRadius[scaleKey];
  }
  for (const [alias, value] of Object.entries(durationAliases)) {
    vars[`--smrt-duration-${alias}`] = value;
  }
  for (const [alias, value] of Object.entries(fontFamilyAliases)) {
    vars[`--smrt-font-family-${alias}`] = value;
  }
  for (const [name, value] of Object.entries(fontWeightTokens)) {
    vars[`--smrt-typography-weight-${name}`] = value;
  }
  for (const [name, value] of Object.entries(zIndexTokens)) {
    vars[`--smrt-z-index-${name}`] = value;
  }

  return vars;
}
