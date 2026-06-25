/**
 * SMRT Theme
 *
 * Dark-first "engineering instrument panel" theme adapted from the
 * happyvertical.com workbench look: near-black surfaces, an amber signal
 * accent (`#ff7a1a`), hairline outlines, deep low shadows, and a
 * Space Grotesk / Inter / JetBrains Mono type stack.
 *
 * The token palette restyles every existing smrt-ui component; the signature
 * motifs (engineering-grid background, glow, oscilloscope hairline, instrument
 * readouts, monospace technical labels) ship as opt-in utility classes in
 * `styles/smrt.css`, and the fonts in `styles/fonts.css`.
 */

import { borderRadiusScale, durationScale, spacingScale } from '../shared.js';
import type {
  ColorPalette,
  EasingScale,
  ElevationScale,
  Theme,
  TypographyScale,
} from '../types.js';

/** Display family (headings) — falls back gracefully when fonts.css is absent. */
const DISPLAY_FONT = '"Space Grotesk", system-ui, -apple-system, sans-serif';

/**
 * SMRT light color palette.
 *
 * The instrument aesthetic is dark-first; the light scheme keeps the amber
 * signal (darkened to `#e35d12` for contrast on white) over cool paper greys,
 * mirroring happyvertical.com's `[data-theme='light']` workbench.
 */
const lightColors: ColorPalette = {
  // Primary - Signal amber (darkened for light-surface contrast)
  primary: '#e35d12',
  onPrimary: '#ffffff',
  primaryContainer: '#ffe6d4',
  onPrimaryContainer: '#7a2e00',

  // Secondary - Cool slate
  secondary: '#5b6470',
  onSecondary: '#ffffff',
  secondaryContainer: '#e7eaee',
  onSecondaryContainer: '#2a2f37',

  // Tertiary - SMRT violet (happyvertical's per-product accent for the framework)
  tertiary: '#6b4eff',
  onTertiary: '#ffffff',
  tertiaryContainer: '#e7e0ff',
  onTertiaryContainer: '#3a2b8c',

  // Error
  error: '#c0362c',
  onError: '#ffffff',
  errorContainer: '#fbe0dd',
  onErrorContainer: '#6b1109',

  // Warning
  warning: '#b06a00',
  onWarning: '#ffffff',
  warningContainer: '#ffedd0',
  onWarningContainer: '#6b4200',

  // Success
  success: '#0f7a5f',
  onSuccess: '#ffffff',
  successContainer: '#d7f2e8',
  onSuccessContainer: '#043a2c',

  // Surface - Cool paper greys
  surface: '#ffffff',
  onSurface: '#14171c',
  surfaceVariant: '#f5f6f8',
  onSurfaceVariant: '#5b6470',
  surfaceContainer: '#f5f6f8',
  surfaceContainerLow: '#fafbfc',
  surfaceContainerHigh: '#eef1f4',
  surfaceContainerHighest: '#e7eaee',
  surfaceContainerLowest: '#ffffff',
  surfaceDim: '#e3e6ea',
  surfaceBright: '#ffffff',

  // Background
  background: '#edeff2',
  onBackground: '#14171c',

  // Outline - Hairline / line greys
  outline: '#c6ccd4',
  outlineVariant: '#dfe3e8',

  // Inverse
  inverseSurface: '#14171c',
  inverseOnSurface: '#f4f6f8',
  inversePrimary: '#ff7a1a',

  // Effects
  shadow: 'rgba(20, 26, 36, 0.28)',
  scrim: 'rgba(0, 0, 0, 0.5)',
};

/**
 * SMRT dark color palette (default).
 *
 * Near-black engineering surfaces (`#0b0c0e` base, `#121417` panels) with the
 * full-strength amber signal `#ff7a1a` and hairline outlines.
 */
const darkColors: ColorPalette = {
  // Primary - Signal amber
  primary: '#ff7a1a',
  onPrimary: '#1a0e02',
  primaryContainer: '#2a1a0c',
  onPrimaryContainer: '#ffb784',

  // Secondary - Cool slate
  secondary: '#9aa3af',
  onSecondary: '#14171c',
  secondaryContainer: '#23272e',
  onSecondaryContainer: '#e6e9ee',

  // Tertiary - SMRT violet
  tertiary: '#b9a8ff',
  onTertiary: '#241a4d',
  tertiaryContainer: '#2a2350',
  onTertiaryContainer: '#ddd4ff',

  // Error
  error: '#ff6b6b',
  onError: '#2a0a0a',
  errorContainer: '#3a1414',
  onErrorContainer: '#ffc4c4',

  // Warning
  warning: '#ffb020',
  onWarning: '#1a0e02',
  warningContainer: '#3a2a0c',
  onWarningContainer: '#ffd9a3',

  // Success
  success: '#3fb98f',
  onSuccess: '#00261c',
  successContainer: '#103a30',
  onSuccessContainer: '#7fd9be',

  // Surface - Near-black instrument panels
  surface: '#121417',
  onSurface: '#c9cdd3',
  surfaceVariant: '#181b1f',
  onSurfaceVariant: '#9aa3af',
  surfaceContainer: '#121417',
  surfaceContainerLow: '#0e1013',
  surfaceContainerHigh: '#181b1f',
  surfaceContainerHighest: '#1f242b',
  surfaceContainerLowest: '#0a0c10',
  surfaceDim: '#0b0c0e',
  surfaceBright: '#23272e',

  // Background
  background: '#0b0c0e',
  onBackground: '#c9cdd3',

  // Outline - Line / hairline strokes
  outline: '#333842',
  outlineVariant: '#23272e',

  // Inverse
  inverseSurface: '#edeff2',
  inverseOnSurface: '#14171c',
  inversePrimary: '#b34d00',

  // Effects
  shadow: 'rgba(0, 0, 0, 0.8)',
  scrim: 'rgba(0, 0, 0, 0.7)',
};

/**
 * SMRT typography scale.
 *
 * Tight, punchy display metrics in Space Grotesk (negative tracking, near-1
 * line-heights) over Inter body text — the workbench's display/body split.
 */
const typography: TypographyScale = {
  displayLarge: {
    size: '3.5rem',
    lineHeight: '0.98',
    weight: '600',
    tracking: '-0.03em',
    fontFamily: DISPLAY_FONT,
  },
  displayMedium: {
    size: '2.75rem',
    lineHeight: '1',
    weight: '600',
    tracking: '-0.03em',
    fontFamily: DISPLAY_FONT,
  },
  displaySmall: {
    size: '2.25rem',
    lineHeight: '1.05',
    weight: '600',
    tracking: '-0.02em',
    fontFamily: DISPLAY_FONT,
  },
  headlineLarge: {
    size: '2rem',
    lineHeight: '1.1',
    weight: '600',
    tracking: '-0.02em',
    fontFamily: DISPLAY_FONT,
  },
  headlineMedium: {
    size: '1.6rem',
    lineHeight: '1.15',
    weight: '600',
    tracking: '-0.02em',
    fontFamily: DISPLAY_FONT,
  },
  headlineSmall: {
    size: '1.3rem',
    lineHeight: '1.2',
    weight: '600',
    tracking: '-0.01em',
    fontFamily: DISPLAY_FONT,
  },
  titleLarge: {
    size: '1.125rem',
    lineHeight: '1.3',
    weight: '600',
    tracking: '-0.01em',
    fontFamily: 'var(--smrt-font-family)',
  },
  titleMedium: {
    size: '1rem',
    lineHeight: '1.4',
    weight: '600',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  titleSmall: {
    size: '0.875rem',
    lineHeight: '1.4',
    weight: '600',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  bodyLarge: {
    size: '1.0625rem',
    lineHeight: '1.6',
    weight: '400',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  bodyMedium: {
    size: '0.9375rem',
    lineHeight: '1.6',
    weight: '400',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  bodySmall: {
    size: '0.8125rem',
    lineHeight: '1.55',
    weight: '400',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelLarge: {
    size: '0.8125rem',
    lineHeight: '1.4',
    weight: '600',
    tracking: '0.04em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelMedium: {
    size: '0.6875rem',
    lineHeight: '1.4',
    weight: '600',
    tracking: '0.08em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelSmall: {
    size: '0.625rem',
    lineHeight: '1.4',
    weight: '600',
    tracking: '0.1em',
    fontFamily: 'var(--smrt-font-family)',
  },
};

/**
 * SMRT elevation (light) — deep, soft, low-spread shadows.
 *
 * The workbench panels sit on big diffuse drop shadows with a tight inset
 * hairline at level 1. Light scheme tints the shadow with the cool ink grey.
 */
const elevation: ElevationScale = {
  0: 'none',
  1: 'inset 0 0 0 1px rgba(20, 26, 36, 0.08)',
  2: '0 18px 44px -28px rgba(20, 26, 36, 0.18)',
  3: '0 24px 56px -34px rgba(20, 26, 36, 0.22)',
  4: '0 30px 70px -40px rgba(20, 26, 36, 0.28)',
  5: '0 40px 90px -50px rgba(20, 26, 36, 0.3)',
};

/**
 * SMRT elevation (dark) — black drop shadows with a white inset hairline.
 *
 * Defined here (not only in the static `styles/smrt.css`) so the JS
 * ThemeProvider output and the static dark CSS stay in lockstep (#1586).
 */
const darkElevation: ElevationScale = {
  0: 'none',
  1: 'inset 0 0 0 1px rgba(255, 255, 255, 0.06)',
  2: '0 18px 44px -28px rgba(0, 0, 0, 0.6)',
  3: '0 24px 56px -34px rgba(0, 0, 0, 0.72)',
  4: '0 30px 66px -40px rgba(0, 0, 0, 0.82)',
  5: '0 40px 90px -50px rgba(0, 0, 0, 0.88)',
};

/**
 * SMRT easings — the workbench reveal curve as the emphasized easing.
 */
const smrtEasing: EasingScale = {
  standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
  standardDecelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  standardAccelerate: 'cubic-bezier(0.4, 0, 1, 1)',
  emphasized: 'cubic-bezier(0.22, 1, 0.36, 1)',
  emphasizedDecelerate: 'cubic-bezier(0.16, 1, 0.3, 1)',
  emphasizedAccelerate: 'cubic-bezier(0.4, 0, 1, 1)',
};

/**
 * SMRT theme definition
 */
export const smrtTheme: Theme = {
  id: 'smrt',
  name: 'SMRT',
  light: lightColors,
  dark: darkColors,
  typography,
  elevation,
  darkElevation,
  spacing: spacingScale,
  borderRadius: borderRadiusScale,
  duration: durationScale,
  easing: smrtEasing,
  fontFamily: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
};

export default smrtTheme;
