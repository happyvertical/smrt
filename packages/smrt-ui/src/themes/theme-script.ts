/**
 * Pre-paint theme bootstrap script generator.
 *
 * ThemeProvider resolves the persisted/system color scheme only after mount,
 * so apps without a pre-paint script flash the wrong scheme on load. Apps used
 * to hand-duplicate the provider's storage logic in `app.html`; this helper
 * generates that script from the same config so the two never drift.
 *
 * Usage (root layout — SSR renders `svelte:head` into the initial HTML, so the
 * script runs before first paint):
 *
 * ```svelte
 * <script lang="ts">
 *   import { themeScript } from '@happyvertical/smrt-ui/themes';
 * </script>
 *
 * <svelte:head>
 *   {@html `<script>${themeScript({ preset: 'studio' })}</script>`}
 * </svelte:head>
 * ```
 */
import type { ColorScheme, ThemePreset } from './types.js';
import { defaultThemeConfig } from './types.js';

export interface ThemeScriptOptions {
  /** Preset to stamp as `data-theme` when nothing is persisted. */
  preset?: ThemePreset;
  /** localStorage key — must match ThemeProvider's `storageKey`. */
  storageKey?: string;
  /** Fallback scheme when storage holds no value. Default: 'system'. */
  defaultColorScheme?: ColorScheme;
}

/**
 * Returns the JS body (no `<script>` tags) of a pre-paint bootstrap that
 * mirrors ThemeProvider's persistence: reads the stored config, resolves
 * 'system' via matchMedia, then stamps `data-theme`, `data-color-scheme`,
 * the `dark` class, and `color-scheme` style on <html>.
 */
export function themeScript(options: ThemeScriptOptions = {}): string {
  const preset = options.preset ?? defaultThemeConfig.preset;
  const storageKey = options.storageKey ?? defaultThemeConfig.storageKey;
  const fallback = options.defaultColorScheme ?? 'system';

  // Keep this dependency-free and ES5-ish: it runs inline in every browser
  // before any framework code. Must stay in sync with
  // ThemeProvider.svelte's loadPersistedConfig()/resolvedScheme.
  return `(function(){try{var scheme=${JSON.stringify(fallback)};var preset=${JSON.stringify(preset)};var raw=localStorage.getItem(${JSON.stringify(storageKey)});if(raw){try{var data=JSON.parse(raw);if(data.colorScheme)scheme=data.colorScheme;if(data.preset)preset=data.preset;}catch(_){scheme=raw;}}if(scheme==='system'){scheme=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var el=document.documentElement;el.setAttribute('data-theme',preset);el.setAttribute('data-color-scheme',scheme);el.classList.toggle('dark',scheme==='dark');el.style.colorScheme=scheme;}catch(_){}})();`;
}
