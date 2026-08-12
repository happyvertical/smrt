/**
 * HappyVertical Theme — "Day Shift"
 *
 * The HappyVertical brand identity (happyvertical/smrt#2318), signed off
 * 2026-08-12. A calm instrument panel: a warm-grey enamel ground, raised
 * faceplate panels separated by hairline bezels, graphite ink, and exactly one
 * budgeted accent — a signal amber. The execution rule is the owner's, verbatim:
 * **"calm is less for the brain to process, not theatre."** No decorative
 * vocabulary, no glow, nothing animates unless it represents a state change.
 *
 * Unlike a generated dark scheme, **both schemes are hand-authored**. The dark
 * scheme keeps a blue-graphite cast (rather than collapsing to near-black) and
 * carries both accent hues — amber and green — at dark-surface strengths.
 *
 * Named roles (issue vocabulary → token slots):
 *
 * | role        | light     | dark      | slots                              |
 * |-------------|-----------|-----------|------------------------------------|
 * | enamel      | `#E8EBE9` | `#14181B` | `background`, the ground           |
 * | faceplate   | `#F4F6F5` | `#1C2226` | `surface`, raised panels           |
 * | graphite    | `#20272B` | `#E4E9E7` | `on-surface` / `on-background`     |
 * | etch        | `#5A6660` | `#97A29C` | `on-surface-variant`               |
 * | bezel       | `#C9CFCC` | `#2A3238` | `outline-variant`, hairlines       |
 * | amber       | `#9C5300` | `#FFB454` | `primary`, incl. the focus ring    |
 * | green       | `#1E7A4B` | `#53C989` | `success`                          |
 *
 * `background` is the enamel ground and `surface` is the raised faceplate, so a
 * `Card` (which paints `--smrt-color-surface`) reads as a panel sitting on the
 * ground exactly as in the sign-off mock. The `surface-container-*` ramp is
 * anchored on those two — lightest at `lowest` in light, inverted in dark — and
 * deliberately extends one hand-tuned step past each anchor (`lowest`/`bright`
 * a shade above faceplate, `highest`/`dim` a shade below enamel). Confining all
 * seven levels strictly between enamel and faceplate would compress them into a
 * ~12-value band, and components that stack container levels (DataTable rows
 * under a header, nested panels) would lose their separation entirely.
 *
 * **Green is never text.** It is a status lamp, marker, or container fill only;
 * light `#1E7A4B` measures 4.44:1 on the enamel ground, just under AA. The
 * accent-as-text contrast set in `__tests__/happyvertical-theme.test.ts`
 * excludes `success` and a companion scan enforces that no component in this
 * package paints text with it. Every other text/surface pairing in both schemes
 * clears WCAG AA (4.5:1), and `outline` plus the amber focus ring clear 3:1
 * non-text on every surface slot.
 *
 * `outline` and `outline-variant` are deliberately different strengths, and the
 * distinction is the a11y contract: `outline` is the boundary token and is
 * tuned to clear 3:1 on every surface, while `outline-variant` is the bezel —
 * the decorative hairline between panels — which measures 1.25–1.54:1 in light
 * and 1.03–1.43:1 in dark. That is the look the design signs off on and the
 * same register every other preset here uses for its dividers. Never "fix" the
 * bezel by raising its value; a structure that must be perceivable (a control
 * boundary, a focus ring) should consume `outline` or `primary` instead.
 *
 * The dark bezel sits at the top of the surface ramp, so the ramp deliberately
 * stops below it: `surfaceContainerHighest` and `surfaceBright` were originally
 * authored AT `#2A3238` and a bezel-bordered panel on either was invisible at
 * exactly 1.00:1. They are now distinct, and a test pins that no surface may
 * ever equal `outline-variant` again. Separating them further would mean
 * lifting the top of the ramp past the bezel, which drops `on-surface-variant`
 * below AA on those surfaces — the wrong trade.
 */

import { spacingScale } from '../shared.js';
import type {
  BorderRadiusScale,
  ColorPalette,
  DurationScale,
  EasingScale,
  ElevationScale,
  Theme,
  TypographyScale,
} from '../types.js';

/** Display family (headings, titles) — falls back when the fonts are absent. */
const DISPLAY_FONT =
  '"Archivo", "Helvetica Neue", Helvetica, Arial, sans-serif';

/** Body/UI family. */
const BODY_FONT = '"B612", Verdana, "Segoe UI", system-ui, sans-serif';

/** Technical/monospace family (legends, readouts, code). */
const MONO_FONT =
  '"B612 Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/**
 * Day Shift light palette (canonical).
 *
 * Warm-grey enamel ground with faceplate panels. The amber is darkened to
 * `#9C5300` so white-on-amber clears AA (5.75:1) and the accent still reads as
 * a 3:1 non-text marker on every surface.
 */
const lightColors: ColorPalette = {
  // Primary - Signal amber (the single budgeted accent; also the focus ring)
  primary: '#9c5300',
  onPrimary: '#ffffff',
  primaryContainer: '#f7e3cc',
  onPrimaryContainer: '#5e3200',

  // Secondary - Graphite-green slate
  secondary: '#4f5b55',
  onSecondary: '#ffffff',
  secondaryContainer: '#dce3df',
  onSecondaryContainer: '#2a342f',

  // Tertiary - Instrument blue, the quiet half of the blue-graphite cast
  tertiary: '#3c5a68',
  onTertiary: '#ffffff',
  tertiaryContainer: '#d7e4ea',
  onTertiaryContainer: '#1b333e',

  // Error - Muted enamel-compatible red
  error: '#9b3b32',
  onError: '#ffffff',
  errorContainer: '#f6dfdc',
  onErrorContainer: '#5e1c16',

  // Warning - Shares the amber family, pulled browner so it is not the accent
  warning: '#8a4e08',
  onWarning: '#ffffff',
  warningContainer: '#f7e4c8',
  onWarningContainer: '#533000',

  // Success - Green. Status lamps, markers, and fills only; never text.
  success: '#1e7a4b',
  onSuccess: '#ffffff',
  successContainer: '#d5e9df',
  onSuccessContainer: '#0c3b24',

  // Surface - Faceplate and the gradations down to the enamel ground
  surface: '#f4f6f5',
  onSurface: '#20272b',
  surfaceVariant: '#e5eae7',
  onSurfaceVariant: '#5a6660',
  surfaceContainer: '#f1f4f2',
  surfaceContainerLow: '#f7f9f8',
  surfaceContainerHigh: '#eaeeec',
  surfaceContainerHighest: '#e3e8e5',
  surfaceContainerLowest: '#fbfcfb',
  surfaceDim: '#e1e6e3',
  surfaceBright: '#fbfcfb',

  // Background - Enamel ground
  background: '#e8ebe9',
  onBackground: '#20272b',

  // Outline - Etch family, tuned to clear 3:1 on every surface
  outline: '#717d77',
  outlineVariant: '#c9cfcc',

  // Inverse
  inverseSurface: '#20272b',
  inverseOnSurface: '#edf0ee',
  inversePrimary: '#ffb454',

  // Effects
  shadow: 'rgba(32, 39, 43, 0.2)',
  scrim: 'rgba(20, 24, 27, 0.45)',
};

/**
 * Day Shift dark palette ("night shift").
 *
 * Hand-authored, not derived. Surfaces keep a blue-graphite cast (`#14181B`
 * ground, `#1C2226` faceplate, `#2A3238` bezel) instead of collapsing to
 * near-black, and both accent hues survive: amber `#FFB454` at ~10:1 on the
 * ground and green `#53C989` for lamps and fills.
 */
const darkColors: ColorPalette = {
  // Primary - Signal amber at dark-surface strength
  primary: '#ffb454',
  onPrimary: '#14181b',
  primaryContainer: '#3b2a12',
  onPrimaryContainer: '#ffd7a1',

  // Secondary - Graphite-green slate
  secondary: '#a6b2ac',
  onSecondary: '#14181b',
  secondaryContainer: '#262e33',
  onSecondaryContainer: '#dce3e0',

  // Tertiary - Instrument blue
  tertiary: '#9cbecc',
  onTertiary: '#10262e',
  tertiaryContainer: '#1e313a',
  onTertiaryContainer: '#c6dee8',

  // Error
  error: '#e89b92',
  onError: '#3b120d',
  errorContainer: '#402019',
  onErrorContainer: '#f7c9c3',

  // Warning - Amber family, lifted off primary
  warning: '#ffc46b',
  onWarning: '#14181b',
  warningContainer: '#3b2c12',
  onWarningContainer: '#ffdca8',

  // Success - Green. Status lamps, markers, and fills only; never text.
  success: '#53c989',
  onSuccess: '#06331e',
  successContainer: '#14382a',
  onSuccessContainer: '#a8e5c4',

  // Surface - Blue-graphite faceplates over the night ground
  surface: '#1c2226',
  onSurface: '#e4e9e7',
  surfaceVariant: '#232b30',
  onSurfaceVariant: '#97a29c',
  surfaceContainer: '#1c2226',
  surfaceContainerLow: '#171c20',
  surfaceContainerHigh: '#212930',
  surfaceContainerHighest: '#252d33',
  surfaceContainerLowest: '#0f1315',
  surfaceDim: '#101416',
  surfaceBright: '#283036',

  // Background - Night enamel
  background: '#14181b',
  onBackground: '#e4e9e7',

  // Outline - Etch family, tuned to clear 3:1 on every surface
  outline: '#76827d',
  outlineVariant: '#2a3238',

  // Inverse
  inverseSurface: '#e4e9e7',
  inverseOnSurface: '#1c2226',
  inversePrimary: '#9c5300',

  // Effects
  shadow: 'rgba(0, 0, 0, 0.6)',
  scrim: 'rgba(0, 0, 0, 0.6)',
};

/**
 * Day Shift typography.
 *
 * Archivo (500/600) sets display, headline, and title in sentence case with
 * ~-0.01em tracking; B612 (400/700) carries body and label text at a 1.6 body
 * line-height. Nothing is upper-cased by the scale — legends opt in through the
 * `.hv-legend` utility instead.
 */
const typography: TypographyScale = {
  displayLarge: {
    size: '2.9rem',
    lineHeight: '1.15',
    weight: '600',
    tracking: '-0.015em',
    fontFamily: DISPLAY_FONT,
  },
  displayMedium: {
    size: '2.4rem',
    lineHeight: '1.15',
    weight: '600',
    tracking: '-0.015em',
    fontFamily: DISPLAY_FONT,
  },
  displaySmall: {
    size: '2rem',
    lineHeight: '1.2',
    weight: '600',
    tracking: '-0.01em',
    fontFamily: DISPLAY_FONT,
  },
  headlineLarge: {
    size: '1.75rem',
    lineHeight: '1.2',
    weight: '600',
    tracking: '-0.01em',
    fontFamily: DISPLAY_FONT,
  },
  headlineMedium: {
    size: '1.5rem',
    lineHeight: '1.25',
    weight: '600',
    tracking: '-0.01em',
    fontFamily: DISPLAY_FONT,
  },
  headlineSmall: {
    size: '1.35rem',
    lineHeight: '1.3',
    weight: '600',
    tracking: '-0.01em',
    fontFamily: DISPLAY_FONT,
  },
  titleLarge: {
    size: '1.15rem',
    lineHeight: '1.35',
    weight: '600',
    tracking: '-0.01em',
    fontFamily: DISPLAY_FONT,
  },
  titleMedium: {
    size: '1rem',
    lineHeight: '1.4',
    weight: '500',
    tracking: '-0.01em',
    fontFamily: DISPLAY_FONT,
  },
  titleSmall: {
    size: '0.9rem',
    lineHeight: '1.4',
    weight: '500',
    tracking: '-0.01em',
    fontFamily: DISPLAY_FONT,
  },
  bodyLarge: {
    size: '1rem',
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
    size: '0.875rem',
    lineHeight: '1.55',
    weight: '400',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelLarge: {
    size: '0.9rem',
    lineHeight: '1.4',
    weight: '700',
    tracking: '0',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelMedium: {
    size: '0.8125rem',
    lineHeight: '1.4',
    weight: '700',
    tracking: '0.02em',
    fontFamily: 'var(--smrt-font-family)',
  },
  labelSmall: {
    size: '0.75rem',
    lineHeight: '1.4',
    weight: '700',
    tracking: '0.08em',
    fontFamily: 'var(--smrt-font-family)',
  },
};

/**
 * Day Shift elevation (light) — flat with hairline bezels.
 *
 * Level 1 is the hairline itself; levels 2+ add the minimum soft shadow that
 * still separates an overlay from the panel underneath. Closer to studio than
 * to material — a raised faceplate, not a floating card.
 */
const elevation: ElevationScale = {
  0: 'none',
  1: 'inset 0 0 0 1px rgba(32, 39, 43, 0.1)',
  2: '0 1px 2px 0 rgba(32, 39, 43, 0.06)',
  3: '0 2px 6px -2px rgba(32, 39, 43, 0.1)',
  4: '0 6px 16px -6px rgba(32, 39, 43, 0.14)',
  5: '0 12px 28px -12px rgba(32, 39, 43, 0.18)',
};

/**
 * Day Shift elevation (dark) — a white inset hairline over black drop shadows.
 *
 * Defined here (not only in `styles/happyvertical.css`) so the JS ThemeProvider
 * output and the static dark CSS stay in lockstep (#1586).
 */
const darkElevation: ElevationScale = {
  0: 'none',
  1: 'inset 0 0 0 1px rgba(228, 233, 231, 0.08)',
  2: '0 1px 2px 0 rgba(0, 0, 0, 0.4)',
  3: '0 2px 6px -2px rgba(0, 0, 0, 0.5)',
  4: '0 6px 16px -6px rgba(0, 0, 0, 0.6)',
  5: '0 12px 28px -12px rgba(0, 0, 0, 0.7)',
};

/**
 * Day Shift radii — the mock's restrained geometry: 6px controls, 8px panels.
 */
const borderRadius: BorderRadiusScale = {
  none: '0',
  sm: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  xl: '0.75rem',
  '2xl': '1rem',
  '3xl': '1.25rem',
  full: '9999px',
};

/**
 * Day Shift motion — ~120ms state transitions.
 *
 * `normal` is the 120ms the spec calls for; the rest of the scale stays tight
 * around it, because nothing animates here unless it represents a state change.
 * (The shared Material-3 `short1…long4` aliases from #1431 are emitted
 * unchanged across every preset and are not part of this scale.)
 */
const duration: DurationScale = {
  instant: '0ms',
  fast: '90ms',
  normal: '120ms',
  slow: '180ms',
  slower: '260ms',
};

/**
 * Day Shift easing — one calm curve everywhere.
 *
 * A single easing is the point: varying the curve per interaction is theatre,
 * and the execution rule rejects it.
 */
const calmEasing: EasingScale = {
  standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
  standardDecelerate: 'cubic-bezier(0.4, 0, 0.2, 1)',
  standardAccelerate: 'cubic-bezier(0.4, 0, 0.2, 1)',
  emphasized: 'cubic-bezier(0.4, 0, 0.2, 1)',
  emphasizedDecelerate: 'cubic-bezier(0.4, 0, 0.2, 1)',
  emphasizedAccelerate: 'cubic-bezier(0.4, 0, 0.2, 1)',
};

/**
 * HappyVertical "Day Shift" theme definition
 */
export const happyverticalTheme: Theme = {
  id: 'happyvertical',
  name: 'Day Shift',
  light: lightColors,
  dark: darkColors,
  typography,
  elevation,
  darkElevation,
  spacing: spacingScale,
  borderRadius,
  duration,
  easing: calmEasing,
  fontFamily: BODY_FONT,
  fontFamilyMono: MONO_FONT,
};

export default happyverticalTheme;
