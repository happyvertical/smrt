/**
 * Studio Theme
 *
 * Google AI Studio-inspired flat design theme.
 * Minimal shadows, monochromatic base with vibrant accents,
 * clean lines, and a focus on content clarity.
 */

import { baselineTokens, opaqueGlass } from '../derive.js';
import {
  borderRadiusScale,
  darkInsetHighlight,
  durationScale,
  hairlineInset,
  hairlineMix,
  noInsetHighlight,
  noShadow,
  shadow,
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

  // Info - Shares the tertiary hue (no distinct info hue in this preset)
  info: '#9334e6',
  onInfo: '#ffffff',
  infoContainer: '#f3e8fd',
  onInfoContainer: '#6b12b8',

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
  // Boundary role: must clear 3:1 non-text on every surface in this scheme so
  // control borders are perceivable (WCAG 1.4.11). Was #dadce0, a divider-weight
  // grey measuring 1.21–1.37:1 — invisible as a control boundary (#2322).
  // outlineVariant below stays the quiet hairline for dividers and panels.
  outline: '#78797b',
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

  // Info - Shares the tertiary hue (no distinct info hue in this preset)
  info: '#c58af9',
  onInfo: '#3e1385',
  infoContainer: '#6b12b8',
  onInfoContainer: '#f3e8fd',

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

  // Surface - Cool flat greys; panel equals ground and is separated by a hairline
  surface: '#131416',
  onSurface: '#e8eaed',
  surfaceVariant: '#1c1d20',
  onSurfaceVariant: '#9aa0a6',
  surfaceContainer: '#1a1b1e',
  surfaceContainerLow: '#16171a',
  surfaceContainerHigh: '#202124',
  surfaceContainerHighest: '#292a2d',
  surfaceContainerLowest: '#0e0f10',
  surfaceDim: '#0e0f10',
  surfaceBright: '#2b2c2f',

  // Background
  background: '#131416',
  onBackground: '#e8eaed',

  // Outline
  outline: '#8c8e92',
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
    tracking: '-0.02em',
    fontFamily: 'var(--smrt-font-family)',
  },
  displayMedium: {
    size: '2.5rem',
    lineHeight: '1.15',
    weight: '400',
    tracking: '-0.015em',
    fontFamily: 'var(--smrt-font-family)',
  },
  displaySmall: {
    size: '2rem',
    lineHeight: '1.2',
    weight: '400',
    tracking: '-0.01em',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineLarge: {
    size: '1.75rem',
    lineHeight: '1.25',
    weight: '400',
    tracking: '-0.01em',
    fontFamily: 'var(--smrt-font-family)',
  },
  headlineMedium: {
    size: '1.5rem',
    lineHeight: '1.3',
    weight: '400',
    tracking: '-0.005em',
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
    tracking: '0.01em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelMedium: {
    size: '0.75rem',
    lineHeight: '1.5',
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
 * Studio elevation (light) — flat. Level 1 is the hairline itself; the rest are
 * crisp two-layer shadows (tight contact, short ambient) so overlays separate
 * without softness.
 */
const elevation: ElevationScale = {
  0: noShadow,
  1: hairlineInset,
  2: shadow([
    [1, 2, 0, 10],
    [2, 4, -2, 8],
  ]),
  3: shadow([
    [1, 2, 0, 12],
    [4, 8, -3, 10],
  ]),
  4: shadow([
    [2, 3, 0, 12],
    [8, 16, -4, 12],
  ]),
  5: shadow([
    [2, 4, 0, 14],
    [16, 32, -8, 16],
  ]),
};

/**
 * Studio elevation (dark) — the hairline at level 1, tighter shadows above it
 * with the inset top highlight. Defined here (not only in the static
 * `styles/studio.css`) so the JS ThemeProvider output and the static dark CSS
 * stay in lockstep (#1586).
 */
const darkElevation: ElevationScale = {
  0: noShadow,
  1: hairlineInset,
  2: shadow(
    [
      [1, 2, 0, 28],
      [2, 4, -2, 20],
    ],
    'var(--smrt-inset-highlight)',
  ),
  3: shadow(
    [
      [1, 2, 0, 30],
      [4, 8, -3, 24],
    ],
    'var(--smrt-inset-highlight)',
  ),
  4: shadow(
    [
      [2, 3, 0, 32],
      [8, 16, -4, 28],
    ],
    'var(--smrt-inset-highlight)',
  ),
  5: shadow(
    [
      [2, 4, 0, 34],
      [16, 32, -8, 32],
    ],
    'var(--smrt-inset-highlight)',
  ),
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
  darkElevation,
  spacing: spacingScale,
  borderRadius: borderRadiusScale,
  duration: durationScale,
  easing: studioEasing,
  glass: { ...opaqueGlass },
  ...baselineTokens(lightColors, darkColors),
  shadowColor: { light: 'rgb(60 64 67)', dark: 'rgb(0 0 0)' },
  // Flat: panel equals ground (a hairline separates them); controls sit a hair
  // darker in light and a step lighter in dark; overlays are the highest tier.
  surfaces: {
    light: {
      ground: lightColors.background,
      panel: lightColors.surface,
      control: '#f6f7f8',
      raised: lightColors.surfaceContainerLowest,
      sunken: lightColors.surfaceContainer,
      overlay: lightColors.scrim,
    },
    dark: {
      ground: darkColors.background,
      panel: darkColors.surface,
      control: '#1c1d20',
      raised: darkColors.surfaceContainerHighest,
      sunken: darkColors.surfaceContainerLowest,
      overlay: darkColors.scrim,
    },
  },
  hairlines: {
    light: hairlineMix(12, 32, noInsetHighlight),
    dark: hairlineMix(14, 32, darkInsetHighlight(0.05)),
  },
  states: {
    hover: '0.06',
    pressed: '0.10',
    selected: '0.10',
    focus: '0.10',
    dragged: '0.14',
    disabled: '0.38',
  },
  // Crisp: a 6px radius and a denser control height.
  controls: {
    radius: '0.375rem',
    radiusSmall: 'var(--smrt-radius-sm)',
    height: '2.5rem',
    heightSmall: '2rem',
    weight: '500',
  },
  fontFamily: '"Google Sans Text", "Roboto", "Segoe UI", system-ui, sans-serif',
};

export default studioTheme;
