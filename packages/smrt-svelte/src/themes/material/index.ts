/**
 * Material Theme
 *
 * Improved Material Design 3 theme with modern Google product aesthetics.
 * Features refined colors, updated typography, and polished elevation.
 */

import {
  borderRadiusScale,
  durationScale,
  materialEasing,
  spacingScale,
} from '../shared.js';
import type {
  ColorPalette,
  ElevationScale,
  Theme,
  TypographyScale,
} from '../types.js';

/**
 * Material light color palette
 * Refined M3 colors with slightly more vibrant accents
 */
const lightColors: ColorPalette = {
  // Primary - Vibrant blue like modern Google products
  primary: '#0b57d0',
  onPrimary: '#ffffff',
  primaryContainer: '#d3e3fd',
  onPrimaryContainer: '#041e49',

  // Secondary - Neutral with slight warm tint
  secondary: '#5e5e5e',
  onSecondary: '#ffffff',
  secondaryContainer: '#f0f0f0',
  onSecondaryContainer: '#1f1f1f',

  // Tertiary - Soft purple
  tertiary: '#7c4dff',
  onTertiary: '#ffffff',
  tertiaryContainer: '#e8ddff',
  onTertiaryContainer: '#1e005f',

  // Error - Google red
  error: '#b3261e',
  onError: '#ffffff',
  errorContainer: '#f9dedc',
  onErrorContainer: '#410e0b',

  // Warning - Amber
  warning: '#f9ab00',
  onWarning: '#000000',
  warningContainer: '#fff4d9',
  onWarningContainer: '#3d2a00',

  // Success - Green
  success: '#1e8e3e',
  onSuccess: '#ffffff',
  successContainer: '#e6f4ea',
  onSuccessContainer: '#1e4620',

  // Surface - Clean white with subtle warm tint
  surface: '#ffffff',
  onSurface: '#1f1f1f',
  surfaceVariant: '#f2f2f2',
  onSurfaceVariant: '#444746',
  surfaceContainer: '#f0f4f8',
  surfaceContainerLow: '#f8f9fa',
  surfaceContainerHigh: '#e8eaed',
  surfaceContainerHighest: '#e1e3e6',
  surfaceContainerLowest: '#ffffff',
  surfaceDim: '#dadce0',
  surfaceBright: '#f8f9fa',

  // Background
  background: '#ffffff',
  onBackground: '#1f1f1f',

  // Outline
  outline: '#747775',
  outlineVariant: '#c4c7c5',

  // Inverse
  inverseSurface: '#303133',
  inverseOnSurface: '#f2f2f2',
  inversePrimary: '#a8c7fa',

  // Effects
  shadow: '#000000',
  scrim: 'rgba(0, 0, 0, 0.5)',
};

/**
 * Material dark color palette
 * True dark mode with OLED-friendly blacks
 */
const darkColors: ColorPalette = {
  // Primary - Lighter blue for dark mode
  primary: '#a8c7fa',
  onPrimary: '#062e6f',
  primaryContainer: '#0842a0',
  onPrimaryContainer: '#d3e3fd',

  // Secondary
  secondary: '#c7c7c7',
  onSecondary: '#303133',
  secondaryContainer: '#444746',
  onSecondaryContainer: '#e3e3e3',

  // Tertiary
  tertiary: '#cbb7ff',
  onTertiary: '#3e1e96',
  tertiaryContainer: '#5e3fc0',
  onTertiaryContainer: '#e8ddff',

  // Error
  error: '#f2b8b5',
  onError: '#601410',
  errorContainer: '#8c1d18',
  onErrorContainer: '#f9dedc',

  // Warning
  warning: '#ffcd66',
  onWarning: '#5c3d00',
  warningContainer: '#8a5d00',
  onWarningContainer: '#fff4d9',

  // Success
  success: '#81c995',
  onSuccess: '#0d522d',
  successContainer: '#1e4620',
  onSuccessContainer: '#e6f4ea',

  // Surface - True dark OLED black base
  surface: '#0e0e0e',
  onSurface: '#e3e3e3',
  surfaceVariant: '#1f1f1f',
  onSurfaceVariant: '#c4c7c5',
  surfaceContainer: '#1f1f1f',
  surfaceContainerLow: '#141414',
  surfaceContainerHigh: '#2d2d2d',
  surfaceContainerHighest: '#363636',
  surfaceContainerLowest: '#0a0a0a',
  surfaceDim: '#141414',
  surfaceBright: '#2d2d2d',

  // Background
  background: '#0e0e0e',
  onBackground: '#e3e3e3',

  // Outline
  outline: '#8e918f',
  outlineVariant: '#444746',

  // Inverse
  inverseSurface: '#e3e3e3',
  inverseOnSurface: '#1f1f1f',
  inversePrimary: '#0b57d0',

  // Effects
  shadow: '#000000',
  scrim: 'rgba(0, 0, 0, 0.7)',
};

/**
 * Material typography scale
 * Uses Google Sans / Roboto-style metrics
 */
const typography: TypographyScale = {
  displayLarge: {
    size: '3.5rem',
    lineHeight: '1.1',
    weight: '400',
    tracking: '-0.02em',
    fontFamily: 'var(--smrt-font-family)',
  },
  displayMedium: {
    size: '2.75rem',
    lineHeight: '1.15',
    weight: '400',
    tracking: '-0.01em',
    fontFamily: 'var(--smrt-font-family)',
  },
  displaySmall: {
    size: '2.25rem',
    lineHeight: '1.2',
    weight: '400',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineLarge: {
    size: '2rem',
    lineHeight: '1.25',
    weight: '400',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineMedium: {
    size: '1.75rem',
    lineHeight: '1.3',
    weight: '400',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineSmall: {
    size: '1.5rem',
    lineHeight: '1.35',
    weight: '400',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  titleLarge: {
    size: '1.375rem',
    lineHeight: '1.4',
    weight: '500',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  titleMedium: {
    size: '1rem',
    lineHeight: '1.5',
    weight: '500',
    tracking: '0.01em',
    fontFamily: 'var(--smrt-font-family)',
  },
  titleSmall: {
    size: '0.875rem',
    lineHeight: '1.5',
    weight: '500',
    tracking: '0.01em',
    fontFamily: 'var(--smrt-font-family)',
  },
  bodyLarge: {
    size: '1rem',
    lineHeight: '1.5',
    weight: '400',
    tracking: '0.03em',
    fontFamily: 'var(--smrt-font-family)',
  },
  bodyMedium: {
    size: '0.875rem',
    lineHeight: '1.5',
    weight: '400',
    tracking: '0.02em',
    fontFamily: 'var(--smrt-font-family)',
  },
  bodySmall: {
    size: '0.75rem',
    lineHeight: '1.4',
    weight: '400',
    tracking: '0.03em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelLarge: {
    size: '0.875rem',
    lineHeight: '1.4',
    weight: '500',
    tracking: '0.01em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelMedium: {
    size: '0.75rem',
    lineHeight: '1.4',
    weight: '500',
    tracking: '0.05em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelSmall: {
    size: '0.6875rem',
    lineHeight: '1.4',
    weight: '500',
    tracking: '0.05em',
    fontFamily: 'var(--smrt-font-family)',
  },
};

/**
 * Material elevation shadows
 * More refined shadows with better diffusion
 */
const elevation: ElevationScale = {
  0: 'none',
  1: '0 1px 2px 0 rgb(0 0 0 / 0.05), 0 1px 3px 0 rgb(0 0 0 / 0.02)',
  2: '0 1px 2px 0 rgb(0 0 0 / 0.06), 0 2px 4px 0 rgb(0 0 0 / 0.04)',
  3: '0 2px 4px 0 rgb(0 0 0 / 0.06), 0 4px 8px 0 rgb(0 0 0 / 0.04)',
  4: '0 4px 8px 0 rgb(0 0 0 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.04)',
  5: '0 8px 16px 0 rgb(0 0 0 / 0.1), 0 16px 32px 0 rgb(0 0 0 / 0.04)',
};

/**
 * Material theme definition
 */
export const materialTheme: Theme = {
  id: 'material',
  name: 'Material',
  light: lightColors,
  dark: darkColors,
  typography,
  elevation,
  spacing: spacingScale,
  borderRadius: borderRadiusScale,
  duration: durationScale,
  easing: materialEasing,
  fontFamily: '"Google Sans", "Roboto", system-ui, -apple-system, sans-serif',
};

export default materialTheme;
