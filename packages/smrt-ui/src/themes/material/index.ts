/**
 * Material Theme
 *
 * Improved Material Design 3 theme with modern Google product aesthetics.
 * Features refined colors, updated typography, and polished elevation.
 */

import { baselineTokens, opaqueGlass } from '../derive.js';
import {
  borderRadiusScale,
  darkInsetHighlight,
  durationScale,
  hairlineMix,
  materialEasing,
  noInsetHighlight,
  noShadow,
  shadow,
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

  // Info - Shares the tertiary hue (no distinct info hue in this preset)
  info: '#7c4dff',
  onInfo: '#ffffff',
  infoContainer: '#e8ddff',
  onInfoContainer: '#1e005f',

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
  background: '#f6f8fc',
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
 * M3 tonal dark mode: a #121316 ground with stepped container tiers
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

  // Info - Shares the tertiary hue (no distinct info hue in this preset)
  info: '#cbb7ff',
  onInfo: '#3e1e96',
  infoContainer: '#5e3fc0',
  onInfoContainer: '#e8ddff',

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

  // Surface - M3 tonal ladder (ground < panel < control < raised), each tier a
  // visible step so depth reads from lightness and needs no borders
  surface: '#1b1c20',
  onSurface: '#e3e3e3',
  surfaceVariant: '#26282c',
  onSurfaceVariant: '#c4c7c5',
  surfaceContainer: '#1f2024',
  surfaceContainerLow: '#17181c',
  surfaceContainerHigh: '#26282c',
  surfaceContainerHighest: '#34363a',
  surfaceContainerLowest: '#0d0e11',
  surfaceDim: '#121316',
  surfaceBright: '#393b3f',

  // Background
  background: '#121316',
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
    tracking: '-0.015em',
    fontFamily: 'var(--smrt-font-family)',
  },
  displaySmall: {
    size: '2.25rem',
    lineHeight: '1.2',
    weight: '400',
    tracking: '-0.01em',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineLarge: {
    size: '2rem',
    lineHeight: '1.25',
    weight: '400',
    tracking: '-0.01em',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineMedium: {
    size: '1.75rem',
    lineHeight: '1.3',
    weight: '400',
    tracking: '-0.005em',
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
    tracking: '0.02em',
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
 * Material elevation (light) — two layers per level: a contact shadow plus an
 * ambient shadow with negative spread, tinted by `--smrt-shadow-color`.
 */
const elevation: ElevationScale = {
  0: noShadow,
  1: shadow([
    [1, 2, 0, 8],
    [2, 4, -1, 6],
  ]),
  2: shadow([
    [1, 2, 0, 10],
    [4, 8, -2, 10],
  ]),
  3: shadow([
    [1, 3, 0, 12],
    [8, 16, -4, 12],
  ]),
  4: shadow([
    [2, 4, 0, 12],
    [12, 24, -6, 14],
  ]),
  5: shadow([
    [2, 6, 0, 14],
    [20, 40, -10, 18],
  ]),
};

/**
 * Material elevation (dark) — altitude is carried by the tonal ladder, so the
 * shadows are tighter and lower in reach and every level adds the inset top
 * highlight.
 */
const darkElevation: ElevationScale = {
  0: noShadow,
  1: shadow([
    [1, 2, 0, 24],
    [1, 3, -1, 16],
  ]),
  2: shadow(
    [
      [1, 2, 0, 28],
      [3, 6, -2, 20],
    ],
    'var(--smrt-inset-highlight)',
  ),
  3: shadow(
    [
      [1, 3, 0, 30],
      [6, 12, -3, 24],
    ],
    'var(--smrt-inset-highlight)',
  ),
  4: shadow(
    [
      [2, 4, 0, 32],
      [10, 20, -5, 28],
    ],
    'var(--smrt-inset-highlight)',
  ),
  5: shadow(
    [
      [2, 6, 0, 34],
      [16, 32, -8, 32],
    ],
    'var(--smrt-inset-highlight)',
  ),
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
  darkElevation,
  spacing: spacingScale,
  borderRadius: borderRadiusScale,
  duration: durationScale,
  easing: materialEasing,
  glass: { ...opaqueGlass },
  ...baselineTokens(lightColors, darkColors),
  shadowColor: { light: 'rgb(0 0 0)', dark: 'rgb(0 0 0)' },
  // Tonal ladder: ground < panel < control < raised in dark. Light recesses the
  // filled control into the white panel (M3 filled field) and lifts overlays.
  surfaces: {
    light: {
      ground: lightColors.background,
      panel: lightColors.surface,
      control: lightColors.surfaceContainerHigh,
      raised: lightColors.surfaceContainerLowest,
      sunken: '#eef1f6',
      overlay: lightColors.scrim,
    },
    dark: {
      ground: darkColors.background,
      panel: darkColors.surface,
      control: darkColors.surfaceContainerHigh,
      raised: darkColors.surfaceContainerHighest,
      sunken: darkColors.surfaceContainerLowest,
      overlay: darkColors.scrim,
    },
  },
  hairlines: {
    light: hairlineMix(10, 30, noInsetHighlight),
    dark: hairlineMix(10, 30, darkInsetHighlight(0.05)),
  },
  // M3 state layers.
  states: {
    hover: '0.08',
    pressed: '0.12',
    selected: '0.12',
    focus: '0.12',
    dragged: '0.16',
    disabled: '0.38',
  },
  // Filled controls separate by tier, not by an edge.
  controls: {
    radius: 'var(--smrt-radius-md)',
    radiusSmall: 'var(--smrt-radius-sm)',
    height: '2.75rem',
    heightSmall: '2.25rem',
    weight: '500',
    border: '1px solid transparent',
  },
  fontFamily: '"Google Sans", "Roboto", system-ui, -apple-system, sans-serif',
};

export default materialTheme;
