/**
 * Unified Theme System Types
 *
 * Core types for the multi-theme architecture supporting Material, Glass,
 * Studio, SMRT, and HappyVertical themes.
 */

/** Available theme presets */
export type ThemePreset =
  | 'material'
  | 'glass'
  | 'studio'
  | 'smrt'
  | 'happyvertical';

/** Color scheme mode */
export type ColorScheme = 'light' | 'dark' | 'system';

/** Resolved color scheme (never 'system') */
export type ResolvedScheme = 'light' | 'dark';

/** Control target density */
export type ThemeDensity = 'comfortable' | 'touch';

/** Contrast preference accepted by ThemeProvider (`auto` follows the OS) */
export type ContrastPreference = 'auto' | 'standard' | 'more';

/** Resolved contrast level; `forced` means `forced-colors: active` */
export type ResolvedContrast = 'standard' | 'more' | 'forced';

/** Border radius scale */
export type BorderRadius = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full';

/**
 * Color palette for a theme
 * Follows Material 3 semantic naming for consistency
 */
export interface ColorPalette {
  // Primary
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;

  // Secondary
  secondary: string;
  onSecondary: string;
  secondaryContainer: string;
  onSecondaryContainer: string;

  // Tertiary
  tertiary: string;
  onTertiary: string;
  tertiaryContainer: string;
  onTertiaryContainer: string;

  // Info (informational status; presets without a distinct hue reuse tertiary)
  /** Info family; a palette that omits it inherits its tertiary family. */
  info?: string;
  onInfo?: string;
  infoContainer?: string;
  onInfoContainer?: string;

  // Error
  error: string;
  onError: string;
  errorContainer: string;
  onErrorContainer: string;

  // Warning
  warning: string;
  onWarning: string;
  warningContainer: string;
  onWarningContainer: string;

  // Success
  success: string;
  onSuccess: string;
  successContainer: string;
  onSuccessContainer: string;

  // Surface
  surface: string;
  onSurface: string;
  surfaceVariant: string;
  onSurfaceVariant: string;
  surfaceContainer: string;
  surfaceContainerLow: string;
  surfaceContainerHigh: string;
  surfaceContainerHighest: string;
  surfaceContainerLowest: string;
  surfaceDim: string;
  surfaceBright: string;

  // Background
  background: string;
  onBackground: string;

  // Outline
  outline: string;
  outlineVariant: string;

  // Inverse
  inverseSurface: string;
  inverseOnSurface: string;
  inversePrimary: string;

  // Effects
  shadow: string;
  scrim: string;

  // Glass-specific (optional, used by glass theme)
  glassBackdrop?: string;
  glassBorder?: string;
}

/**
 * Typography token
 */
export interface TypographyToken {
  size: string;
  lineHeight: string;
  weight: string | number;
  tracking: string;
  fontFamily?: string;
}

/**
 * Typography scale
 */
export interface TypographyScale {
  displayLarge: TypographyToken;
  displayMedium: TypographyToken;
  displaySmall: TypographyToken;
  headlineLarge: TypographyToken;
  headlineMedium: TypographyToken;
  headlineSmall: TypographyToken;
  titleLarge: TypographyToken;
  titleMedium: TypographyToken;
  titleSmall: TypographyToken;
  bodyLarge: TypographyToken;
  bodyMedium: TypographyToken;
  bodySmall: TypographyToken;
  labelLarge: TypographyToken;
  labelMedium: TypographyToken;
  labelSmall: TypographyToken;
}

/**
 * Elevation/shadow scale
 */
export interface ElevationScale {
  0: string;
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
}

/**
 * Spacing scale
 */
export interface SpacingScale {
  0: string;
  0.5: string;
  1: string;
  1.5: string;
  2: string;
  2.5: string;
  3: string;
  3.5: string;
  4: string;
  5: string;
  6: string;
  7: string;
  8: string;
  9: string;
  10: string;
  11: string;
  12: string;
  14: string;
  16: string;
  20: string;
  24: string;
}

/**
 * Border radius scale
 */
export interface BorderRadiusScale {
  none: string;
  sm: string;
  md: string;
  lg: string;
  xl: string;
  '2xl': string;
  '3xl': string;
  full: string;
}

/**
 * Transition durations
 */
export interface DurationScale {
  instant: string;
  fast: string;
  normal: string;
  slow: string;
  slower: string;
}

/**
 * Transition easings
 */
export interface EasingScale {
  standard: string;
  standardDecelerate: string;
  standardAccelerate: string;
  emphasized: string;
  emphasizedDecelerate: string;
  emphasizedAccelerate: string;
}

/** A pair of values that depend on the resolved colour scheme. */
export interface PerScheme<T> {
  light: T;
  dark: T;
}

/** Surface ladder (`--smrt-surface-*`), from the page ground up to overlays. */
export interface SurfaceLadder {
  /** Page ground behind everything. */
  ground: string;
  /** Panels, cards, sidebars sitting on the ground. */
  panel: string;
  /** Input and control fills. */
  control: string;
  /** Menus, popovers, dialogs lifted above panels. */
  raised: string;
  /** Wells and inset regions recessed below panels. */
  sunken: string;
  /** Modal scrim colour. */
  overlay: string;
}

/** Edge tokens (`--smrt-hairline-*`, `--smrt-inset-highlight`). */
export interface HairlineTokens {
  /** Quiet divider colour. */
  color: string;
  /** Stronger edge colour (control borders). */
  strongColor: string;
  /** `box-shadow` value for the top inner light line (`none` on light). */
  insetHighlight: string;
}

/** Interaction state-layer opacities (unitless, 0 to 1). */
export interface StateLayers {
  hover: string;
  pressed: string;
  selected: string;
  focus: string;
  dragged: string;
  disabled: string;
}

/** Shared control geometry (`--smrt-control-*`). */
export interface ControlTokens {
  radius: string;
  radiusSmall: string;
  height: string;
  heightSmall: string;
  weight: string;
  border: string;
}

/** Focus ring (`--smrt-focus-ring-*`). */
export interface FocusRingTokens {
  color: string;
  width: string;
  offset: string;
}

/** Native browser chrome colours. */
export interface NativeChromeTokens {
  accent: string;
  selectionBackground: string;
  selectionColor: string;
  caret: string;
  scrollbarThumb: string;
  scrollbarTrack: string;
}

/** Translucent glass surfaces (`--smrt-glass-surface*`, `--smrt-glass-border`). */
export interface GlassSurfaces {
  surface: string;
  surfaceStrong: string;
  border: string;
}

/**
 * Glass effect configuration. Every theme has one: non-glass themes use the
 * opaque default (`blur: 0px`, `saturation: 100%`, opaque surfaces) so
 * components can always consume the glass tokens.
 */
export interface GlassEffects {
  /** Backdrop blur amount */
  blur: string;
  /** Saturation adjustment */
  saturation: string;
  /** Per-scheme surfaces; defaults to opaque panel/raised colours. */
  surfaces?: PerScheme<GlassSurfaces>;
  /**
   * @deprecated Emitted as `--smrt-glass-border-opacity` for one release so
   * consumers that read it keep working; the border colour is `surfaces.border`.
   */
  borderOpacity?: string;
  /** @deprecated Emitted as `--smrt-glass-background-opacity`; use `surfaces`. */
  backgroundOpacity?: string;
}

/**
 * Complete theme definition
 */
export interface Theme {
  /** Theme identifier */
  id: ThemePreset;
  /** Theme display name */
  name: string;
  /** Light mode colors */
  light: ColorPalette;
  /** Dark mode colors */
  dark: ColorPalette;
  /** Typography scale */
  typography: TypographyScale;
  /** Elevation shadows (used for both schemes unless `darkElevation` is set) */
  elevation: ElevationScale;
  /**
   * Optional dark-scheme elevation overrides. When present, the CSS generator
   * emits these for the dark scheme instead of `elevation`. Lets a preset tune
   * shadows for a dark surface (e.g. studio's punchier dark shadows) so the JS
   * generator and the static dark CSS can't diverge (#1586).
   */
  darkElevation?: ElevationScale;
  /** Spacing scale */
  spacing: SpacingScale;
  /** Border radius scale */
  borderRadius: BorderRadiusScale;
  /** Transition durations */
  duration: DurationScale;
  /** Transition easings */
  easing: EasingScale;
  /** Glass effects (opaque for non-glass themes) */
  glass?: GlassEffects;
  /** Surface ladder per scheme (derived from the palette when absent) */
  surfaces?: PerScheme<SurfaceLadder>;
  /** Hairline edges per scheme (derived from on-surface when absent) */
  hairlines?: PerScheme<HairlineTokens>;
  /** State-layer opacities (M3-like defaults when absent) */
  states?: StateLayers;
  /** `--smrt-shadow-color` per scheme, an `rgb(r g b)` colour */
  shadowColor?: PerScheme<string>;
  /** Control geometry (derived from the radius scale when absent) */
  controls?: Partial<ControlTokens>;
  /** Focus ring (primary, 2px, 2px offset when absent) */
  focus?: Partial<FocusRingTokens>;
  /** Native chrome per scheme (primary-derived when absent) */
  native?: PerScheme<NativeChromeTokens>;
  /** `--smrt-duration-scheme`, the scheme crossfade duration */
  schemeDuration?: string;
  /** `--smrt-font-feature-settings`, e.g. `"tnum" 1, "cv11" 1` */
  fontFeatureSettings?: string;
  /** Primary font family */
  fontFamily: string;
  /**
   * Optional monospace family override. When absent the preset inherits the
   * shared `--smrt-font-family-mono` stack (#1431); presets whose type stack
   * names its own mono face (e.g. happyvertical's B612 Mono) set it here so the
   * JS generator and the static preset CSS emit the same value.
   */
  fontFamilyMono?: string;
}

/**
 * Theme configuration options
 */
export interface ThemeConfig {
  /** Selected theme preset */
  preset: ThemePreset;
  /** Color scheme preference */
  colorScheme: ColorScheme;
  /** Primary accent color (overrides theme default) */
  primaryColor?: string;
  /** Border radius preference */
  borderRadius?: BorderRadius;
  /** Default control target density; persisted alongside preset/scheme/radius */
  density?: ThemeDensity;
  /** Contrast preference; `auto` follows `prefers-contrast` (persisted when explicit) */
  contrast?: ContrastPreference;
  /** Custom CSS variable overrides */
  overrides?: Record<string, string>;
  /** Persist theme preference */
  persist?: boolean;
  /** Storage key for persistence */
  storageKey?: string;
}

/**
 * Default theme configuration
 */
export const defaultThemeConfig: ThemeConfig = {
  preset: 'material',
  colorScheme: 'system',
  borderRadius: 'md',
  persist: true,
  storageKey: 'smrt-theme',
};

/**
 * Theme state exposed via context
 */
export interface ThemeState {
  /** Current theme preset */
  preset: ThemePreset;
  /** Current color scheme */
  colorScheme: ColorScheme;
  /** Resolved color scheme (never 'system') */
  resolvedScheme: ResolvedScheme;
  /** Whether dark mode is active */
  isDark: boolean;
  /** Resolved contrast level (`forced` when `forced-colors: active`) */
  contrast: ResolvedContrast;
  /** True for one `--smrt-duration-scheme` after the resolved scheme changes post-mount */
  isChangingScheme: boolean;
  /** Full theme configuration */
  config: ThemeConfig;
  /** Current active theme object */
  theme: Theme;
}

/**
 * Theme context interface
 */
export interface ThemeContext {
  /** Current theme state */
  readonly state: ThemeState;
  /** Set theme preset */
  setPreset: (preset: ThemePreset) => void;
  /** Set color scheme */
  setColorScheme: (scheme: ColorScheme) => void;
  /** Toggle between light and dark */
  toggleColorScheme: () => void;
  /** Update theme configuration */
  updateConfig: (updates: Partial<ThemeConfig>) => void;
}

/**
 * CSS variable generation options
 */
export interface CSSVariableOptions {
  /** Prefix for CSS variables */
  prefix?: string;
  /** Include theme ID as data attribute */
  includeThemeId?: boolean;
}
