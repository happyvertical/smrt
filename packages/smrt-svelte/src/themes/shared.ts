/**
 * Shared Theme Tokens
 *
 * Common spacing, border radius, and duration scales used across all themes.
 */

import type {
  BorderRadiusScale,
  DurationScale,
  EasingScale,
  SpacingScale,
} from './types.js';

/**
 * Shared spacing scale (consistent across all themes)
 */
export const spacingScale: SpacingScale = {
  0: '0',
  0.5: '0.125rem',
  1: '0.25rem',
  1.5: '0.375rem',
  2: '0.5rem',
  2.5: '0.625rem',
  3: '0.75rem',
  3.5: '0.875rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  7: '1.75rem',
  8: '2rem',
  9: '2.25rem',
  10: '2.5rem',
  11: '2.75rem',
  12: '3rem',
  14: '3.5rem',
  16: '4rem',
  20: '5rem',
  24: '6rem',
};

/**
 * Material-3 spacing aliases (issue #1431).
 *
 * Components authored against Material-3 vocabulary consume `--smrt-spacing-sm`
 * / `-md` / `-xl` etc. The numeric scale above is canonical; these aliases map
 * the named sizes onto numeric-scale keys so both vocabularies resolve. Emitted
 * in addition to (never instead of) the numeric scale.
 */
export const spacingAliases: Record<string, keyof SpacingScale> = {
  xs: 1, // 0.25rem
  sm: 2, // 0.5rem
  md: 4, // 1rem
  lg: 6, // 1.5rem
  xl: 8, // 2rem
  '2xl': 12, // 3rem
  '3xl': 16, // 4rem
};

/**
 * Shared border radius scale
 */
export const borderRadiusScale: BorderRadiusScale = {
  none: '0',
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
  '2xl': '1.5rem',
  '3xl': '2rem',
  full: '9999px',
};

/**
 * Material-3 border-radius aliases (issue #1431).
 *
 * Maps Material-3 named radii (`extra-small` … `extra-large`) onto the
 * canonical t-shirt scale. Emitted in addition to the canonical names.
 */
export const borderRadiusAliases: Record<string, keyof BorderRadiusScale> = {
  'extra-small': 'sm',
  small: 'sm',
  medium: 'md',
  large: 'lg',
  'extra-large': 'xl',
};

/**
 * Shared duration scale
 */
export const durationScale: DurationScale = {
  instant: '0ms',
  fast: '100ms',
  normal: '200ms',
  slow: '300ms',
  slower: '500ms',
};

/**
 * Material-3 motion-duration aliases (issue #1431).
 *
 * Components consume Material-3 motion tokens (`short2`, `short3`, `medium1`…).
 * These map onto absolute millisecond values following the M3 motion spec
 * (short1=50 … long4=600). Emitted in addition to the canonical
 * instant/fast/normal/slow/slower scale so both vocabularies resolve.
 */
export const durationAliases: Record<string, string> = {
  short1: '50ms',
  short2: '100ms',
  short3: '150ms',
  short4: '200ms',
  medium1: '250ms',
  medium2: '300ms',
  medium3: '350ms',
  medium4: '400ms',
  long1: '450ms',
  long2: '500ms',
  long3: '550ms',
  long4: '600ms',
};

/**
 * Shared font-family aliases (issue #1431).
 *
 * The base body font is `--smrt-font-family`; components also reference a
 * monospace family. Emitted as an explicit token so monospace surfaces (code,
 * transcripts, module IDs) are themeable rather than frozen at a fallback.
 */
export const fontFamilyAliases: Record<string, string> = {
  mono: 'ui-monospace, "SF Mono", "Monaco", "Cascadia Code", "Consolas", monospace',
};

/**
 * Shared named font-weight tokens (issue #1431).
 *
 * The typography scale exposes per-variant weights; these named weights cover
 * generic emphasis (badges, progress labels) that aren't tied to a variant.
 */
export const fontWeightTokens: Record<string, string> = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
};

/**
 * Shared z-index scale (issue #1431).
 *
 * Stacking-context tokens for overlay surfaces so consumers stop hardcoding
 * magic numbers and overlays can be re-layered theme-wide.
 */
export const zIndexTokens: Record<string, string> = {
  dropdown: '1000',
  sticky: '1100',
  overlay: '1200',
  modal: '1300',
  dialog: '1300',
  popover: '1400',
  toast: '1500',
  tooltip: '1600',
  // Full-screen blocking loaders must sit above ALL other layers (#1373).
  loading: '1700',
};

/**
 * Material Design 3 easings
 */
export const materialEasing: EasingScale = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  standardDecelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  standardAccelerate: 'cubic-bezier(0.3, 0, 1, 1)',
  emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
  emphasizedDecelerate: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  emphasizedAccelerate: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
};

/**
 * Apple-style easings (for Glass theme)
 */
export const appleEasing: EasingScale = {
  standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
  standardDecelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  standardAccelerate: 'cubic-bezier(0.4, 0, 1, 1)',
  emphasized: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  emphasizedDecelerate: 'cubic-bezier(0.16, 1, 0.3, 1)',
  emphasizedAccelerate: 'cubic-bezier(0.4, 0, 0.2, 1)',
};

/**
 * Studio-style easings (for Studio theme - snappier)
 */
export const studioEasing: EasingScale = {
  standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
  standardDecelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  standardAccelerate: 'cubic-bezier(0.4, 0, 1, 1)',
  emphasized: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
  emphasizedDecelerate: 'cubic-bezier(0.0, 0, 0.2, 1)',
  emphasizedAccelerate: 'cubic-bezier(0.4, 0, 1, 1)',
};
