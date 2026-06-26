/**
 * Theme Styles
 *
 * Static CSS imports for build-time theming.
 * Import the theme you need for your application.
 *
 * @example
 * ```ts
 * // Import specific theme
 * import '@smrt/svelte/themes/styles/material.css';
 *
 * // Or import all themes (for multi-theme apps)
 * import '@smrt/svelte/themes/styles/all.css';
 * ```
 */

// Note: CSS imports are handled by your bundler (Vite, Webpack, etc.)
// These exports are for TypeScript module resolution

export const themeStyles = {
  material: './material.css',
  glass: './glass.css',
  studio: './studio.css',
  smrt: './smrt.css',
  /** @font-face declarations for the SMRT theme (Space Grotesk / Inter / JetBrains Mono). */
  fonts: './fonts.css',
  all: './all.css',
} as const;
