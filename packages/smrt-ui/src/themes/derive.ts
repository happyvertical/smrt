/**
 * Premium-baseline token derivation (epic #3864, issue #3865).
 *
 * Resolves the surface ladder, hairlines, state layers, shadow colour, control
 * geometry, focus ring, native chrome, glass and motion/typography tokens for
 * one theme and scheme. Presets set explicit values on `Theme`; anything a theme
 * omits (custom themes, `createTheme()`) is derived here from its palette so
 * every theme always defines every token.
 */

import { hexToRgb } from '../utils/theme/color.js';
import type {
  ColorPalette,
  ControlTokens,
  FocusRingTokens,
  GlassSurfaces,
  HairlineTokens,
  NativeChromeTokens,
  StateLayers,
  SurfaceLadder,
  Theme,
} from './types.js';

export const defaultStateLayers: StateLayers = {
  hover: '0.08',
  pressed: '0.12',
  selected: '0.12',
  focus: '0.12',
  dragged: '0.16',
  disabled: '0.38',
};

export const defaultSchemeDuration = 'var(--smrt-duration-medium1)';
export const defaultFontFeatureSettings = 'normal';

/** `rgb(r g b)` from any palette colour; black when it cannot be parsed. */
export function toRgbTriplet(color: string): string {
  try {
    const { r, g, b } = hexToRgb(color);
    if ([r, g, b].some((n) => Number.isNaN(n))) return 'rgb(0 0 0)';
    return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
  } catch {
    return 'rgb(0 0 0)';
  }
}

export function deriveSurfaces(
  colors: ColorPalette,
  isDark: boolean,
): SurfaceLadder {
  return {
    ground: colors.background,
    panel: colors.surface,
    control: isDark
      ? colors.surfaceContainerHigh
      : colors.surfaceContainerLowest,
    raised: isDark
      ? colors.surfaceContainerHigh
      : colors.surfaceContainerLowest,
    sunken: isDark ? colors.surfaceContainerLowest : colors.surfaceContainer,
    overlay: colors.scrim,
  };
}

export function deriveHairlines(
  isDark: boolean,
  prefix = '--smrt',
): HairlineTokens {
  return {
    color: `color-mix(in srgb, var(${prefix}-color-on-surface) 12%, transparent)`,
    strongColor: `color-mix(in srgb, var(${prefix}-color-on-surface) 20%, transparent)`,
    insetHighlight: isDark ? 'inset 0 1px 0 rgb(255 255 255 / 0.06)' : 'none',
  };
}

export function deriveControls(prefix = '--smrt'): ControlTokens {
  return {
    radius: `var(${prefix}-radius-md)`,
    radiusSmall: `var(${prefix}-radius-sm)`,
    height: '2.75rem',
    heightSmall: '2.25rem',
    weight: '500',
    border: `var(${prefix}-hairline-strong)`,
  };
}

export function deriveFocus(prefix = '--smrt'): FocusRingTokens {
  return {
    color: `var(${prefix}-color-primary)`,
    width: '2px',
    offset: '2px',
  };
}

export function deriveNative(prefix = '--smrt'): NativeChromeTokens {
  return {
    accent: `var(${prefix}-color-primary)`,
    selectionBackground: `var(${prefix}-color-primary-container)`,
    selectionColor: `var(${prefix}-color-on-primary-container)`,
    caret: `var(${prefix}-color-primary)`,
    scrollbarThumb: `var(${prefix}-color-outline-variant)`,
    scrollbarTrack: 'transparent',
  };
}

export function deriveGlassSurfaces(prefix = '--smrt'): GlassSurfaces {
  return {
    surface: `var(${prefix}-surface-panel)`,
    surfaceStrong: `var(${prefix}-surface-raised)`,
    border: `var(${prefix}-hairline-color)`,
  };
}

/** Opaque glass default for themes that are not glass. */
export const opaqueGlass = { blur: '0px', saturation: '100%' } as const;

/**
 * Complete set of baseline sections derived from a palette pair. Presets spread
 * this and override what they tune; `createTheme()` uses it directly.
 */
export function baselineTokens(
  light: ColorPalette,
  dark: ColorPalette,
): Pick<
  Theme,
  | 'surfaces'
  | 'hairlines'
  | 'states'
  | 'shadowColor'
  | 'controls'
  | 'focus'
  | 'native'
  | 'schemeDuration'
  | 'fontFeatureSettings'
> {
  return {
    surfaces: {
      light: deriveSurfaces(light, false),
      dark: deriveSurfaces(dark, true),
    },
    hairlines: { light: deriveHairlines(false), dark: deriveHairlines(true) },
    states: { ...defaultStateLayers },
    shadowColor: {
      light: toRgbTriplet(light.shadow),
      dark: toRgbTriplet(dark.shadow),
    },
    controls: deriveControls(),
    focus: deriveFocus(),
    native: { light: deriveNative(), dark: deriveNative() },
    schemeDuration: defaultSchemeDuration,
    fontFeatureSettings: defaultFontFeatureSettings,
  };
}

/** Flat `--prefix-*` map for the premium-baseline families. */
export function generateBaselineVariables(
  theme: Theme,
  isDark: boolean,
  prefix: string,
): Record<string, string> {
  const scheme = isDark ? 'dark' : 'light';
  const colors = isDark ? theme.dark : theme.light;
  const surfaces = theme.surfaces?.[scheme] ?? deriveSurfaces(colors, isDark);
  const hairlines =
    theme.hairlines?.[scheme] ?? deriveHairlines(isDark, prefix);
  const states = { ...defaultStateLayers, ...theme.states };
  const controls = { ...deriveControls(prefix), ...theme.controls };
  const focus = { ...deriveFocus(prefix), ...theme.focus };
  const native = theme.native?.[scheme] ?? deriveNative(prefix);
  const glass = theme.glass ?? opaqueGlass;
  const glassSurfaces = glass.surfaces?.[scheme] ?? deriveGlassSurfaces(prefix);
  const shadowColor =
    theme.shadowColor?.[scheme] ?? toRgbTriplet(colors.shadow);

  return {
    // Surface ladder
    [`${prefix}-surface-ground`]: surfaces.ground,
    [`${prefix}-surface-panel`]: surfaces.panel,
    [`${prefix}-surface-control`]: surfaces.control,
    [`${prefix}-surface-raised`]: surfaces.raised,
    [`${prefix}-surface-sunken`]: surfaces.sunken,
    [`${prefix}-surface-overlay`]: surfaces.overlay,
    // Hairlines
    [`${prefix}-hairline-color`]: hairlines.color,
    [`${prefix}-hairline-strong-color`]: hairlines.strongColor,
    [`${prefix}-hairline`]: `1px solid var(${prefix}-hairline-color)`,
    [`${prefix}-hairline-strong`]: `1px solid var(${prefix}-hairline-strong-color)`,
    [`${prefix}-inset-highlight`]: hairlines.insetHighlight,
    // State layers
    [`${prefix}-state-hover`]: states.hover,
    [`${prefix}-state-pressed`]: states.pressed,
    [`${prefix}-state-selected`]: states.selected,
    [`${prefix}-state-focus`]: states.focus,
    [`${prefix}-state-dragged`]: states.dragged,
    [`${prefix}-state-disabled`]: states.disabled,
    // Depth
    [`${prefix}-shadow-color`]: shadowColor,
    // Controls
    [`${prefix}-control-radius`]: controls.radius,
    [`${prefix}-control-radius-small`]: controls.radiusSmall,
    [`${prefix}-control-height`]: controls.height,
    [`${prefix}-control-height-small`]: controls.heightSmall,
    [`${prefix}-control-weight`]: controls.weight,
    [`${prefix}-control-border`]: controls.border,
    // Focus ring
    [`${prefix}-focus-ring-color`]: focus.color,
    [`${prefix}-focus-ring-width`]: focus.width,
    [`${prefix}-focus-ring-offset`]: focus.offset,
    // Native chrome
    [`${prefix}-accent-color`]: native.accent,
    [`${prefix}-selection-background`]: native.selectionBackground,
    [`${prefix}-selection-color`]: native.selectionColor,
    [`${prefix}-caret-color`]: native.caret,
    [`${prefix}-scrollbar-thumb`]: native.scrollbarThumb,
    [`${prefix}-scrollbar-track`]: native.scrollbarTrack,
    // Glass
    [`${prefix}-glass-blur`]: glass.blur,
    [`${prefix}-glass-saturation`]: glass.saturation,
    [`${prefix}-glass-surface`]: glassSurfaces.surface,
    [`${prefix}-glass-surface-strong`]: glassSurfaces.surfaceStrong,
    [`${prefix}-glass-border`]: glassSurfaces.border,
    // Motion and typography
    [`${prefix}-duration-scheme`]:
      theme.schemeDuration ?? defaultSchemeDuration,
    [`${prefix}-font-feature-settings`]:
      theme.fontFeatureSettings ?? defaultFontFeatureSettings,
  };
}
