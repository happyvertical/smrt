/**
 * Glass Theme
 *
 * Apple-inspired glass morphism theme with backdrop blur effects,
 * translucency, and layered depth. Features frosted glass surfaces
 * and vibrant material effects.
 */

import {
  appleEasing,
  borderRadiusScale,
  durationScale,
  spacingScale,
} from '../shared.js';
import type {
  ColorPalette,
  ElevationScale,
  GlassEffects,
  Theme,
  TypographyScale,
} from '../types.js';

/**
 * Glass light color palette
 * Translucent whites with subtle color tints
 */
const lightColors: ColorPalette = {
  // Primary - Apple system blue
  primary: '#007aff',
  onPrimary: '#ffffff',
  primaryContainer: 'rgba(0, 122, 255, 0.15)',
  onPrimaryContainer: '#003d80',

  // Secondary - System gray
  secondary: '#6c757d',
  onSecondary: '#ffffff',
  secondaryContainer: 'rgba(108, 117, 125, 0.12)',
  onSecondaryContainer: '#2c3237',

  // Tertiary - System indigo
  tertiary: '#5856d6',
  onTertiary: '#ffffff',
  tertiaryContainer: 'rgba(88, 86, 214, 0.15)',
  onTertiaryContainer: '#2a2866',

  // Error - System red
  error: '#ff3b30',
  onError: '#ffffff',
  errorContainer: 'rgba(255, 59, 48, 0.15)',
  onErrorContainer: '#801810',

  // Warning - System orange
  warning: '#ff9500',
  onWarning: '#000000',
  warningContainer: 'rgba(255, 149, 0, 0.15)',
  onWarningContainer: '#804a00',

  // Success - System green
  success: '#34c759',
  onSuccess: '#000000',
  successContainer: 'rgba(52, 199, 89, 0.15)',
  onSuccessContainer: '#1a642d',

  // Surface - Translucent whites
  surface: 'rgba(255, 255, 255, 0.72)',
  onSurface: '#000000',
  surfaceVariant: 'rgba(255, 255, 255, 0.52)',
  onSurfaceVariant: '#3c3c43',
  surfaceContainer: 'rgba(255, 255, 255, 0.82)',
  surfaceContainerLow: 'rgba(255, 255, 255, 0.62)',
  surfaceContainerHigh: 'rgba(255, 255, 255, 0.88)',
  surfaceContainerHighest: 'rgba(255, 255, 255, 0.92)',
  surfaceContainerLowest: 'rgba(255, 255, 255, 0.42)',
  surfaceDim: 'rgba(120, 120, 128, 0.16)',
  surfaceBright: 'rgba(255, 255, 255, 0.95)',

  // Background - Vibrant light background
  background: '#f2f2f7',
  onBackground: '#000000',

  // Outline - Subtle translucent borders
  outline: 'rgba(120, 120, 128, 0.29)',
  outlineVariant: 'rgba(120, 120, 128, 0.16)',

  // Inverse
  inverseSurface: '#1c1c1e',
  inverseOnSurface: '#ffffff',
  inversePrimary: '#66b0ff',

  // Effects
  shadow: 'rgba(0, 0, 0, 0.12)',
  scrim: 'rgba(0, 0, 0, 0.4)',

  // Glass-specific
  glassBackdrop: 'rgba(255, 255, 255, 0.72)',
  glassBorder: 'rgba(255, 255, 255, 0.3)',
};

/**
 * Glass dark color palette
 * Translucent darks with depth layers
 */
const darkColors: ColorPalette = {
  // Primary - Lighter blue for dark mode
  primary: '#0a84ff',
  onPrimary: '#000000',
  primaryContainer: 'rgba(10, 132, 255, 0.25)',
  onPrimaryContainer: '#b3d9ff',

  // Secondary
  secondary: '#8e8e93',
  onSecondary: '#000000',
  secondaryContainer: 'rgba(142, 142, 147, 0.2)',
  onSecondaryContainer: '#e5e5ea',

  // Tertiary
  tertiary: '#5e5ce6',
  onTertiary: '#ffffff',
  tertiaryContainer: 'rgba(94, 92, 230, 0.25)',
  onTertiaryContainer: '#d4d3ff',

  // Error
  error: '#ff453a',
  onError: '#000000',
  errorContainer: 'rgba(255, 69, 58, 0.25)',
  onErrorContainer: '#ffcac7',

  // Warning
  warning: '#ff9f0a',
  onWarning: '#000000',
  warningContainer: 'rgba(255, 159, 10, 0.25)',
  onWarningContainer: '#ffe3b3',

  // Success
  success: '#30d158',
  onSuccess: '#000000',
  successContainer: 'rgba(48, 209, 88, 0.25)',
  onSuccessContainer: '#b8f5c9',

  // Surface - Translucent darks
  surface: 'rgba(30, 30, 30, 0.72)',
  onSurface: '#ffffff',
  surfaceVariant: 'rgba(44, 44, 46, 0.65)',
  onSurfaceVariant: '#8e8e93',
  surfaceContainer: 'rgba(44, 44, 46, 0.82)',
  surfaceContainerLow: 'rgba(30, 30, 30, 0.62)',
  surfaceContainerHigh: 'rgba(58, 58, 60, 0.85)',
  surfaceContainerHighest: 'rgba(72, 72, 74, 0.88)',
  surfaceContainerLowest: 'rgba(28, 28, 30, 0.55)',
  surfaceDim: 'rgba(0, 0, 0, 0.3)',
  surfaceBright: 'rgba(58, 58, 60, 0.9)',

  // Background - Deep dark with subtle tint
  background: '#000000',
  onBackground: '#ffffff',

  // Outline
  outline: 'rgba(84, 84, 88, 0.65)',
  outlineVariant: 'rgba(84, 84, 88, 0.35)',

  // Inverse
  inverseSurface: '#f2f2f7',
  inverseOnSurface: '#000000',
  inversePrimary: '#007aff',

  // Effects
  shadow: 'rgba(0, 0, 0, 0.4)',
  scrim: 'rgba(0, 0, 0, 0.6)',

  // Glass-specific
  glassBackdrop: 'rgba(30, 30, 30, 0.72)',
  glassBorder: 'rgba(255, 255, 255, 0.1)',
};

/**
 * Glass typography scale
 * Apple SF Pro-style metrics
 */
const typography: TypographyScale = {
  displayLarge: {
    size: '3rem',
    lineHeight: '1.1',
    weight: '600',
    tracking: '-0.022em',
    fontFamily: 'var(--smrt-font-family)',
  },
  displayMedium: {
    size: '2.5rem',
    lineHeight: '1.15',
    weight: '600',
    tracking: '-0.021em',
    fontFamily: 'var(--smrt-font-family)',
  },
  displaySmall: {
    size: '2rem',
    lineHeight: '1.2',
    weight: '600',
    tracking: '-0.019em',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineLarge: {
    size: '1.75rem',
    lineHeight: '1.25',
    weight: '600',
    tracking: '-0.017em',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineMedium: {
    size: '1.5rem',
    lineHeight: '1.3',
    weight: '600',
    tracking: '-0.015em',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineSmall: {
    size: '1.25rem',
    lineHeight: '1.35',
    weight: '600',
    tracking: '-0.012em',
    fontFamily: 'var(--smrt-font-family)',
  },
  titleLarge: {
    size: '1.25rem',
    lineHeight: '1.4',
    weight: '600',
    tracking: '-0.012em',
    fontFamily: 'var(--smrt-font-family)',
  },
  titleMedium: {
    size: '1.0625rem',
    lineHeight: '1.4',
    weight: '600',
    tracking: '-0.011em',
    fontFamily: 'var(--smrt-font-family)',
  },
  titleSmall: {
    size: '0.9375rem',
    lineHeight: '1.4',
    weight: '600',
    tracking: '-0.009em',
    fontFamily: 'var(--smrt-font-family)',
  },
  bodyLarge: {
    size: '1.0625rem',
    lineHeight: '1.5',
    weight: '400',
    tracking: '-0.011em',
    fontFamily: 'var(--smrt-font-family)',
  },
  bodyMedium: {
    size: '0.9375rem',
    lineHeight: '1.5',
    weight: '400',
    tracking: '-0.009em',
    fontFamily: 'var(--smrt-font-family)',
  },
  bodySmall: {
    size: '0.8125rem',
    lineHeight: '1.4',
    weight: '400',
    tracking: '-0.006em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelLarge: {
    size: '0.9375rem',
    lineHeight: '1.4',
    weight: '500',
    tracking: '-0.009em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelMedium: {
    size: '0.8125rem',
    lineHeight: '1.4',
    weight: '500',
    tracking: '-0.006em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelSmall: {
    size: '0.6875rem',
    lineHeight: '1.3',
    weight: '600',
    tracking: '-0.004em',
    fontFamily: 'var(--smrt-font-family)',
  },
};

/**
 * Glass elevation
 * Softer, more diffuse shadows with color tint
 */
const elevation: ElevationScale = {
  0: 'none',
  1: '0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02)',
  2: '0 3px 6px rgba(0, 0, 0, 0.06), 0 2px 4px rgba(0, 0, 0, 0.03)',
  3: '0 6px 12px rgba(0, 0, 0, 0.08), 0 4px 8px rgba(0, 0, 0, 0.04)',
  4: '0 12px 24px rgba(0, 0, 0, 0.1), 0 8px 16px rgba(0, 0, 0, 0.05)',
  5: '0 24px 48px rgba(0, 0, 0, 0.12), 0 16px 32px rgba(0, 0, 0, 0.06)',
};

/**
 * Glass effect configuration
 */
const glassEffects: GlassEffects = {
  blur: '20px',
  saturation: '180%',
  borderOpacity: '0.3',
  backgroundOpacity: '0.72',
};

/**
 * Glass theme definition
 */
export const glassTheme: Theme = {
  id: 'glass',
  name: 'Glass',
  light: lightColors,
  dark: darkColors,
  typography,
  elevation,
  spacing: spacingScale,
  borderRadius: borderRadiusScale,
  duration: durationScale,
  easing: appleEasing,
  glass: glassEffects,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif',
};

export default glassTheme;
