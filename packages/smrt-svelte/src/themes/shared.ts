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
