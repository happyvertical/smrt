/**
 * Glass Theme
 *
 * Apple-inspired glass morphism theme with backdrop blur effects,
 * translucency, and layered depth. Features frosted glass surfaces
 * and vibrant material effects.
 */

import { baselineTokens } from '../derive.js';
import {
  appleEasing,
  borderRadiusScale,
  darkInsetHighlight,
  durationScale,
  hairlineMix,
  shadow,
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

  // Info - Shares the tertiary hue (no distinct info hue in this preset)
  info: '#5856d6',
  onInfo: '#ffffff',
  infoContainer: 'rgba(88, 86, 214, 0.15)',
  onInfoContainer: '#2a2866',

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

  // Outline - Translucent borders.
  // `outline` is the boundary role and must clear 3:1 non-text once its alpha
  // is composited over the frosted surface (WCAG 1.4.11). At the original
  // rgba(120, 120, 128, 0.29) it composited to 1.42:1 — a control border no one
  // could see. Darkened the hue rather than pushing alpha toward opaque, which
  // keeps the translucent character (#2322). `outlineVariant` stays the quiet
  // hairline for dividers and panel edges.
  outline: 'rgba(80, 80, 88, 0.75)',
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

  // Info - Shares the tertiary hue (no distinct info hue in this preset)
  info: '#5e5ce6',
  onInfo: '#ffffff',
  infoContainer: 'rgba(94, 92, 230, 0.25)',
  onInfoContainer: '#d4d3ff',

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
  surface: 'rgba(29, 29, 38, 0.72)',
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
  background: '#0b0b0f',
  onBackground: '#ffffff',

  // Outline — see the light-scheme note. Composited over the dark frosted
  // surface the original rgba(84, 84, 88, 0.65) measured 1.70:1; lightening the
  // hue clears 3:1 while staying translucent (#2322).
  outline: 'rgba(160, 160, 166, 0.8)',
  outlineVariant: 'rgba(84, 84, 88, 0.35)',

  // Inverse
  inverseSurface: '#f2f2f7',
  inverseOnSurface: '#000000',
  inversePrimary: '#007aff',

  // Effects
  shadow: 'rgba(0, 0, 0, 0.4)',
  scrim: 'rgba(0, 0, 0, 0.6)',

  // Glass-specific
  glassBackdrop: 'rgba(29, 29, 38, 0.72)',
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
    weight: '500',
    tracking: '-0.004em',
    fontFamily: 'var(--smrt-font-family)',
  },
};

/**
 * Glass elevation (light) — soft, diffuse two-layer shadows: a faint contact
 * line and a wide ambient layer with negative spread so panels float without a
 * hard edge.
 */
const elevation: ElevationScale = {
  0: 'none',
  1: shadow([
    [1, 2, 0, 5],
    [2, 6, -2, 5],
  ]),
  2: shadow([
    [1, 3, 0, 6],
    [6, 14, -4, 8],
  ]),
  3: shadow([
    [2, 4, 0, 7],
    [12, 24, -8, 10],
  ]),
  4: shadow([
    [2, 6, 0, 8],
    [20, 40, -12, 12],
  ]),
  5: shadow([
    [4, 8, 0, 8],
    [32, 64, -16, 16],
  ]),
};

/**
 * Glass elevation (dark) — translucency and the inset top highlight carry the
 * depth; the shadows only support it.
 */
const darkElevation: ElevationScale = {
  0: 'none',
  1: shadow([
    [1, 2, 0, 20],
    [2, 6, -2, 14],
  ]),
  2: shadow(
    [
      [1, 3, 0, 24],
      [6, 14, -4, 18],
    ],
    'var(--smrt-inset-highlight)',
  ),
  3: shadow(
    [
      [2, 4, 0, 26],
      [12, 24, -8, 22],
    ],
    'var(--smrt-inset-highlight)',
  ),
  4: shadow(
    [
      [2, 6, 0, 28],
      [20, 40, -12, 26],
    ],
    'var(--smrt-inset-highlight)',
  ),
  5: shadow(
    [
      [4, 8, 0, 30],
      [32, 64, -16, 30],
    ],
    'var(--smrt-inset-highlight)',
  ),
};

/**
 * Glass effect configuration
 */
const glassEffects: GlassEffects = {
  blur: '20px',
  saturation: '180%',
  // Translucent frosted surfaces; the opacity is part of each colour.
  surfaces: {
    light: {
      surface: 'color-mix(in srgb, #ffffff 72%, transparent)',
      surfaceStrong: 'color-mix(in srgb, #ffffff 88%, transparent)',
      border: 'var(--smrt-hairline-color)',
    },
    dark: {
      surface: 'color-mix(in srgb, #1d1d26 72%, transparent)',
      surfaceStrong: 'color-mix(in srgb, #1d1d26 88%, transparent)',
      border: 'color-mix(in srgb, #ffffff 10%, transparent)',
    },
  },
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
  darkElevation,
  spacing: spacingScale,
  borderRadius: borderRadiusScale,
  duration: durationScale,
  easing: appleEasing,
  ...baselineTokens(lightColors, darkColors),
  shadowColor: { light: 'rgb(0 0 0)', dark: 'rgb(0 0 0)' },
  // The ladder is expressed through translucency over the ground. Panels are
  // frosted glass (72%), inputs are recessed glass (a tinted well that reads as
  // pressed into the panel), and popovers are thicker glass (88%).
  surfaces: {
    light: {
      ground: lightColors.background,
      panel: 'color-mix(in srgb, #ffffff 72%, transparent)',
      control: 'color-mix(in srgb, #767680 12%, transparent)',
      raised: 'color-mix(in srgb, #ffffff 88%, transparent)',
      sunken: 'color-mix(in srgb, #767680 8%, transparent)',
      overlay: lightColors.scrim,
    },
    dark: {
      ground: darkColors.background,
      panel: 'color-mix(in srgb, #1d1d26 72%, transparent)',
      control: 'color-mix(in srgb, #000000 28%, transparent)',
      raised: 'color-mix(in srgb, #2a2a34 88%, transparent)',
      sunken: 'color-mix(in srgb, #000000 38%, transparent)',
      overlay: darkColors.scrim,
    },
  },
  hairlines: {
    light: hairlineMix(10, 26, 'none'),
    dark: hairlineMix(12, 28, darkInsetHighlight(0.1)),
  },
  // Slightly stronger than Material: translucent fills need a firmer response.
  states: {
    hover: '0.10',
    pressed: '0.14',
    selected: '0.14',
    focus: '0.14',
    dragged: '0.18',
    disabled: '0.38',
  },
  // Pill-ish controls: radius lg.
  controls: {
    radius: 'var(--smrt-radius-lg)',
    radiusSmall: 'var(--smrt-radius-md)',
    height: '2.75rem',
    heightSmall: '2.25rem',
    weight: '500',
  },
  glass: glassEffects,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif',
};

export default glassTheme;
