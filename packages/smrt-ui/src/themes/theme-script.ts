/**
 * Pre-paint theme bootstrap script generator.
 *
 * ThemeProvider resolves the persisted/system color scheme only after mount,
 * so apps without a pre-paint script flash the wrong scheme on load. Apps used
 * to hand-duplicate the provider's storage logic in `app.html`; this helper
 * generates that script from the same config so the two never drift.
 *
 * The script only stamps attributes (`data-theme`, `data-color-scheme`, the
 * `dark` class, `color-scheme` style) — the actual variable values come from
 * the static per-preset stylesheets (`themes/styles/<preset>.css`), which are
 * keyed on exactly those attributes and apply before first paint. This keeps
 * the inline bootstrap ~400 bytes instead of shipping a full preset×scheme
 * variable matrix in every HTML response.
 *
 * Usage (root layout — SSR renders `svelte:head` into the initial HTML, so the
 * script runs before first paint):
 *
 * ```svelte
 * <script lang="ts">
 *   import { themeScript } from '@happyvertical/smrt-ui/themes';
 *   import '@happyvertical/smrt-ui/themes/styles/all.css';
 * </script>
 *
 * <svelte:head>
 *   {@html `<script>${themeScript({ preset: 'studio' })}</script>`}
 * </svelte:head>
 * ```
 */

import { getThemeOptions } from './registry.js';
import type { ColorScheme, ThemePreset } from './types.js';
import { defaultThemeConfig } from './types.js';

export interface ThemeScriptOptions {
  /** Preset to stamp as `data-theme` when nothing is persisted. */
  preset?: ThemePreset;
  /** Read persisted preferences. Must match ThemeProvider's `persist` prop. */
  persist?: boolean;
  /** localStorage key — must match ThemeProvider's `storageKey`. */
  storageKey?: string;
  /** Fallback scheme when storage holds no value. Default: 'system'. */
  defaultColorScheme?: ColorScheme;
}

function inlineJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Returns the JS body (no `<script>` tags) of a pre-paint bootstrap that
 * mirrors ThemeProvider's persistence: reads the stored config, resolves
 * 'system' via matchMedia, then stamps `data-theme`, `data-color-scheme`,
 * the `dark` class, and `color-scheme` style on <html>. Variable values are
 * delivered by the static stylesheets selected by those attributes, so the
 * persisted preset/scheme paints correctly before hydration with no inline
 * variable payload.
 */
export function themeScript(options: ThemeScriptOptions = {}): string {
  const presetNames = getThemeOptions().map(({ value }) => value);
  const requestedPreset = options.preset ?? defaultThemeConfig.preset;
  const preset = presetNames.includes(requestedPreset)
    ? requestedPreset
    : defaultThemeConfig.preset;
  const persist = options.persist ?? defaultThemeConfig.persist;
  const storageKey = options.storageKey ?? defaultThemeConfig.storageKey;
  const requestedFallback =
    options.defaultColorScheme ?? defaultThemeConfig.colorScheme;
  const fallback: ColorScheme = ['light', 'dark', 'system'].includes(
    requestedFallback,
  )
    ? requestedFallback
    : defaultThemeConfig.colorScheme;

  // Keep this dependency-free and ES5-ish: it runs inline in every browser
  // before any framework code. Must stay in sync with
  // ThemeProvider.svelte's loadPersistedConfig()/resolvedScheme.
  return `(function(){try{var presets=${inlineJSON(presetNames)};var scheme=${inlineJSON(fallback)};var preset=${inlineJSON(preset)};${persist ? `try{var raw=localStorage.getItem(${inlineJSON(storageKey)});if(raw){var data=JSON.parse(raw);if(data&&typeof data==='object'){if(data.colorScheme==='light'||data.colorScheme==='dark'||data.colorScheme==='system')scheme=data.colorScheme;if(typeof data.preset==='string'&&presets.indexOf(data.preset)!==-1)preset=data.preset;}}}catch(_){}` : ''}if(scheme==='system'){scheme=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var el=document.documentElement;el.setAttribute('data-theme',preset);el.setAttribute('data-color-scheme',scheme);el.classList.toggle('dark',scheme==='dark');el.style.colorScheme=scheme;}catch(_){}})();`;
}
