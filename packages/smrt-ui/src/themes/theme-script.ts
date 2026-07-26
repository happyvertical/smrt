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

import { generateThemeVariables } from './css-generator.js';
import { getTheme, getThemeOptions } from './registry.js';
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

function bootstrapVariableName(variable: string): string {
  return variable.replace(/^--smrt-/, '--smrt-bootstrap-');
}

/**
 * Returns the JS body (no `<script>` tags) of a pre-paint bootstrap that
 * mirrors ThemeProvider's persistence: reads the stored config, resolves
 * 'system' via matchMedia, then stamps `data-theme`, `data-color-scheme`,
 * the `dark` class, and `color-scheme` style on <html>. It also sets temporary
 * bootstrap variables consumed by ThemeProvider's SSR inline fallbacks, so the
 * persisted preset/scheme wins before hydration rather than only changing
 * attributes around an already-painted default wrapper.
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

  const variableNames = Array.from(
    new Set(
      presetNames.flatMap((name) => [
        ...Object.keys(generateThemeVariables(getTheme(name), false)),
        ...Object.keys(generateThemeVariables(getTheme(name), true)),
      ]),
    ),
  );
  const bootstrapNames = variableNames.map(bootstrapVariableName);
  const variableRows = presetNames.flatMap((name) =>
    [false, true].map((dark) => {
      const variables = generateThemeVariables(getTheme(name), dark);
      return variableNames.map((variable) => variables[variable] ?? '');
    }),
  );

  // Keep this dependency-free and ES5-ish: it runs inline in every browser
  // before any framework code. Must stay in sync with
  // ThemeProvider.svelte's loadPersistedConfig()/resolvedScheme.
  return `(function(){try{var presets=${inlineJSON(presetNames)};var names=${inlineJSON(bootstrapNames)};var rows=${inlineJSON(variableRows)};var scheme=${inlineJSON(fallback)};var preset=${inlineJSON(preset)};${persist ? `try{var raw=localStorage.getItem(${inlineJSON(storageKey)});if(raw){var data=JSON.parse(raw);if(data&&typeof data==='object'){if(data.colorScheme==='light'||data.colorScheme==='dark'||data.colorScheme==='system')scheme=data.colorScheme;if(typeof data.preset==='string'&&presets.indexOf(data.preset)!==-1)preset=data.preset;}}}catch(_){}` : ''}if(scheme==='system'){scheme=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var el=document.documentElement;el.setAttribute('data-theme',preset);el.setAttribute('data-color-scheme',scheme);el.setAttribute('data-smrt-theme-bootstrap','');el.classList.toggle('dark',scheme==='dark');el.style.colorScheme=scheme;var row=rows[presets.indexOf(preset)*2+(scheme==='dark'?1:0)];for(var i=0;i<names.length;i++){if(row[i])el.style.setProperty(names[i],row[i]);}}catch(_){}})();`;
}
