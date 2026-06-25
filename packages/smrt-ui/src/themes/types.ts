/**
 * Unified Theme System Types
 *
 * Core types for the multi-theme architecture supporting Material, Glass, and Studio themes.
 */

/** Available theme presets */
export type ThemePreset = 'material' | 'glass' | 'studio' | 'smrt';

/** Color scheme mode */
export type ColorScheme = 'light' | 'dark' | 'system';

/** Resolved color scheme (never 'system') */
export type ResolvedScheme = 'light' | 'dark';

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

/**
 * Glass effect configuration
 */
export interface GlassEffects {
  /** Backdrop blur amount */
  blur: string;
  /** Saturation adjustment */
  saturation: string;
  /** Border opacity */
  borderOpacity: string;
  /** Background opacity */
  backgroundOpacity: string;
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
  /** Glass effects (for glass theme) */
  glass?: GlassEffects;
  /** Primary font family */
  fontFamily: string;
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
