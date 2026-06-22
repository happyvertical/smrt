/**
 * Studio Theme
 *
 * Google AI Studio-inspired flat design theme.
 * Minimal shadows, monochromatic base with vibrant accents,
 * clean lines, and a focus on content clarity.
 */

import {
  borderRadiusScale,
  durationScale,
  spacingScale,
  studioEasing,
} from '../shared.js';
import type {
  ColorPalette,
  ElevationScale,
  Theme,
  TypographyScale,
} from '../types.js';

/**
 * Studio light color palette
 * Monochromatic base with vibrant accent colors
 */
const lightColors: ColorPalette = {
  // Primary - Google Blue
  primary: '#1a73e8',
  onPrimary: '#ffffff',
  primaryContainer: '#e8f0fe',
  onPrimaryContainer: '#174ea6',

  // Secondary - Neutral gray
  secondary: '#5f6368',
  onSecondary: '#ffffff',
  secondaryContainer: '#f1f3f4',
  onSecondaryContainer: '#3c4043',

  // Tertiary - Purple accent
  tertiary: '#9334e6',
  onTertiary: '#ffffff',
  tertiaryContainer: '#f3e8fd',
  onTertiaryContainer: '#6b12b8',

  // Error - Google red
  error: '#d93025',
  onError: '#ffffff',
  errorContainer: '#fce8e6',
  onErrorContainer: '#a50e0e',

  // Warning - Amber
  warning: '#f9ab00',
  onWarning: '#000000',
  warningContainer: '#fef3c7',
  onWarningContainer: '#92400e',

  // Success - Teal/green
  success: '#188038',
  onSuccess: '#ffffff',
  successContainer: '#e6f4ea',
  onSuccessContainer: '#137333',

  // Surface - Pure white, flat
  surface: '#ffffff',
  onSurface: '#202124',
  surfaceVariant: '#f8f9fa',
  onSurfaceVariant: '#5f6368',
  surfaceContainer: '#f1f3f4',
  surfaceContainerLow: '#f8f9fa',
  surfaceContainerHigh: '#e8eaed',
  surfaceContainerHighest: '#dadce0',
  surfaceContainerLowest: '#ffffff',
  surfaceDim: '#e8eaed',
  surfaceBright: '#ffffff',

  // Background - Clean white
  background: '#ffffff',
  onBackground: '#202124',

  // Outline - Light gray borders
  outline: '#dadce0',
  outlineVariant: '#e8eaed',

  // Inverse
  inverseSurface: '#3c4043',
  inverseOnSurface: '#f1f3f4',
  inversePrimary: '#8ab4f8',

  // Effects - Minimal shadows
  shadow: 'rgba(60, 64, 67, 0.1)',
  scrim: 'rgba(0, 0, 0, 0.5)',
};

/**
 * Studio dark color palette
 * True dark mode with subtle color accents
 */
const darkColors: ColorPalette = {
  // Primary - Lighter blue
  primary: '#8ab4f8',
  onPrimary: '#062e6f',
  primaryContainer: '#174ea6',
  onPrimaryContainer: '#d2e3fc',

  // Secondary
  secondary: '#9aa0a6',
  onSecondary: '#202124',
  secondaryContainer: '#3c4043',
  onSecondaryContainer: '#e8eaed',

  // Tertiary
  tertiary: '#c58af9',
  onTertiary: '#3e1385',
  tertiaryContainer: '#6b12b8',
  onTertiaryContainer: '#f3e8fd',

  // Error
  error: '#f28b82',
  onError: '#5c150c',
  errorContainer: '#a50e0e',
  onErrorContainer: '#fce8e6',

  // Warning
  warning: '#fdd663',
  onWarning: '#5c3d00',
  warningContainer: '#92400e',
  onWarningContainer: '#fef3c7',

  // Success
  success: '#81c995',
  onSuccess: '#0d3b1f',
  successContainer: '#137333',
  onSuccessContainer: '#e6f4ea',

  // Surface - Near black
  surface: '#0e0e0e',
  onSurface: '#e8eaed',
  surfaceVariant: '#1f1f1f',
  onSurfaceVariant: '#9aa0a6',
  surfaceContainer: '#1f1f1f',
  surfaceContainerLow: '#141414',
  surfaceContainerHigh: '#2d2d2d',
  surfaceContainerHighest: '#3c4043',
  surfaceContainerLowest: '#0a0a0a',
  surfaceDim: '#141414',
  surfaceBright: '#2d2d2d',

  // Background
  background: '#0e0e0e',
  onBackground: '#e8eaed',

  // Outline
  outline: '#5f6368',
  outlineVariant: '#3c4043',

  // Inverse
  inverseSurface: '#e8eaed',
  inverseOnSurface: '#202124',
  inversePrimary: '#1a73e8',

  // Effects
  shadow: 'rgba(0, 0, 0, 0.3)',
  scrim: 'rgba(0, 0, 0, 0.7)',
};

/**
 * Studio typography scale
 * Clean, modern sans-serif with tighter metrics
 */
const typography: TypographyScale = {
  displayLarge: {
    size: '3rem',
    lineHeight: '1.1',
    weight: '400',
    tracking: '-0.01em',
    fontFamily: 'var(--smrt-font-family)',
  },
  displayMedium: {
    size: '2.5rem',
    lineHeight: '1.15',
    weight: '400',
    tracking: '-0.008em',
    fontFamily: 'var(--smrt-font-family)',
  },
  displaySmall: {
    size: '2rem',
    lineHeight: '1.2',
    weight: '400',
    tracking: '-0.005em',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineLarge: {
    size: '1.75rem',
    lineHeight: '1.25',
    weight: '400',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineMedium: {
    size: '1.5rem',
    lineHeight: '1.3',
    weight: '400',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineSmall: {
    size: '1.25rem',
    lineHeight: '1.35',
    weight: '500',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  titleLarge: {
    size: '1.125rem',
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
    lineHeight: '1.6',
    weight: '400',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  bodyMedium: {
    size: '0.875rem',
    lineHeight: '1.6',
    weight: '400',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  bodySmall: {
    size: '0.75rem',
    lineHeight: '1.5',
    weight: '400',
    tracking: '0.01em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelLarge: {
    size: '0.875rem',
    lineHeight: '1.5',
    weight: '500',
    tracking: '0.02em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelMedium: {
    size: '0.75rem',
    lineHeight: '1.5',
    weight: '500',
    tracking: '0.025em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelSmall: {
    size: '0.6875rem',
    lineHeight: '1.4',
    weight: '500',
    tracking: '0.03em',
    fontFamily: 'var(--smrt-font-family)',
  },
};

/**
 * Studio elevation - Minimal, subtle shadows
 * Flat design philosophy with only slight depth indication
 */
const elevation: ElevationScale = {
  0: 'none',
  1: 'inset 0 0 0 1px rgba(60, 64, 67, 0.08)',
  2: '0 1px 2px 0 rgba(60, 64, 67, 0.08), 0 1px 3px 0 rgba(60, 64, 67, 0.04)',
  3: '0 2px 4px 0 rgba(60, 64, 67, 0.1), 0 1px 2px 0 rgba(60, 64, 67, 0.06)',
  4: '0 4px 8px 0 rgba(60, 64, 67, 0.1), 0 2px 4px 0 rgba(60, 64, 67, 0.06)',
  5: '0 8px 16px 0 rgba(60, 64, 67, 0.12), 0 4px 8px 0 rgba(60, 64, 67, 0.06)',
};

/**
 * Studio theme definition
 */
export const studioTheme: Theme = {
  id: 'studio',
  name: 'Studio',
  light: lightColors,
  dark: darkColors,
  typography,
  elevation,
  spacing: spacingScale,
  borderRadius: borderRadiusScale,
  duration: durationScale,
  easing: studioEasing,
  fontFamily: '"Google Sans Text", "Roboto", "Segoe UI", system-ui, sans-serif',
};

export default studioTheme;
