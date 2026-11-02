<script lang="ts">
import type { Snippet } from 'svelte';
import { onMount, untrack } from 'svelte';
import { SMRT_CASCADE_LAYERS_CSS } from '../styles/layers.js';
import {
  setThemeContext,
  type ThemeContext,
  tryGetThemeContext,
} from './context.svelte.js';
import { derivePrimaryOverrides } from './create-theme.js';
import { generateThemeVariables } from './css-generator.js';
import { FORCED_COLORS_TOKENS } from './forced-colors.js';
import { availablePresets, getTheme, isValidPreset } from './registry.js';
import type {
  ColorScheme,
  ContrastPreference,
  ResolvedContrast,
  Theme,
  ThemeConfig,
  ThemePreset,
  ThemeState as ThemeStateType,
} from './types.js';
import { defaultThemeConfig } from './types.js';

interface Props {
  /** Default control target density for descendants; individual controls may override. */
  density?: ThemeConfig['density'];
  /**
   * Contrast preference. `auto` (default) follows `prefers-contrast: more`;
   * `forced-colors: active` always wins. Persisted when set explicitly.
   */
  contrast?: ContrastPreference;
  /** Theme preset to use */
  preset?: ThemePreset;
  /** Color scheme preference */
  colorScheme?: ColorScheme;
  /** Primary accent color override */
  primaryColor?: string;
  /** Border radius preference */
  borderRadius?: ThemeConfig['borderRadius'];
  /** Custom CSS variable overrides */
  overrides?: Record<string, string>;
  /**
   * Paint the theme's background/color/font onto the wrapper. Set false when
   * the host app owns its surface palette and only wants the CSS variables +
   * scheme context — avoids specificity-fighting `.smrt-theme-root`.
   */
  paintSurface?: boolean;
  /** Persist preferences to localStorage */
  persist?: boolean;
  /** Storage key for persistence */
  storageKey?: string;
  /**
   * Force runtime generation of the full CSS variable set onto the wrapper's
   * inline style (the legacy delivery path). Defaults to `true` for custom
   * registered themes — they have no static stylesheet — and `false` for
   * built-in presets, whose variables ship as static CSS
   * (`themes/styles/<preset>.css`) selected by the `data-theme` /
   * `data-color-scheme` attributes. Leave unset unless you cannot import the
   * static stylesheet for a built-in preset.
   */
  inlineVariables?: boolean;
  /**
   * Where the theme attributes land. `document` (the default for a root
   * provider) also stamps `data-theme`, `data-color-scheme`, the `dark` class,
   * `color-scheme`, `data-contrast`, `data-density` and
   * `data-smrt-theme-changing` onto `<html>`. `local` themes only this
   * provider's own wrapper and never touches the document. A provider nested
   * inside another `ThemeProvider` is `local` by default, so an embedded
   * widget cannot retheme its host page (#4485).
   */
  scope?: 'document' | 'local';
  /** Content */
  children: Snippet;
}

let {
  preset = defaultThemeConfig.preset,
  colorScheme = defaultThemeConfig.colorScheme,
  primaryColor,
  borderRadius = defaultThemeConfig.borderRadius,
  overrides = {},
  paintSurface = true,
  persist = defaultThemeConfig.persist,
  storageKey = defaultThemeConfig.storageKey,
  inlineVariables,
  scope,
  children,
  density,
  contrast = 'auto',
}: Props = $props();

// Internal state — seed from the props (which already default to
// defaultThemeConfig) rather than the defaults directly, so the FIRST render
// reflects the requested preset. The prop-sync $effect below only runs on the
// client, so seeding from defaults made SSR / first paint / JS-disabled emit
// the default preset regardless of the `preset` prop.
let config = $state<ThemeConfig>(
  // untrack: intentionally capture the props' initial values here; the
  // "Sync props to state" $effect below keeps config reactive to later changes.
  untrack(() => ({
    preset,
    colorScheme,
    primaryColor,
    borderRadius,
    density,
    contrast,
    overrides,
    persist,
    storageKey,
  })),
);

let systemPrefersDark = $state(false);
let systemContrastMore = $state(false);
let systemForcedColors = $state(false);
let isChangingScheme = $state(false);
let mounted = $state(false);

/** Control radius per `borderRadius` choice: [control, small]. `md` is the preset default. */
const CONTROL_RADIUS: Record<
  NonNullable<ThemeConfig['borderRadius']>,
  [string, string]
> = {
  none: ['var(--smrt-radius-none)', 'var(--smrt-radius-none)'],
  sm: ['var(--smrt-radius-sm)', 'var(--smrt-radius-sm)'],
  md: ['var(--smrt-radius-md)', 'var(--smrt-radius-sm)'],
  lg: ['var(--smrt-radius-lg)', 'var(--smrt-radius-md)'],
  xl: ['var(--smrt-radius-xl)', 'var(--smrt-radius-lg)'],
  full: ['var(--smrt-radius-full)', 'var(--smrt-radius-full)'],
};

const resolvedContrast = $derived<ResolvedContrast>(
  systemForcedColors
    ? 'forced'
    : config.contrast === 'more' ||
        (config.contrast !== 'standard' && systemContrastMore)
      ? 'more'
      : 'standard',
);

// Derived state
const currentTheme = $derived<Theme>(getTheme(config.preset));

const resolvedScheme = $derived<'light' | 'dark'>(
  config.colorScheme === 'system'
    ? systemPrefersDark
      ? 'dark'
      : 'light'
    : config.colorScheme,
);

const isDark = $derived(resolvedScheme === 'dark');

// Static-first variable delivery: built-in presets ship their full variable
// set as static stylesheets (`themes/styles/<preset>.css`) selected by the
// data-theme/data-color-scheme attributes, so the wrapper carries no ~200-var
// inline style. Custom registered themes have no static file, so they keep the
// legacy runtime generation (opt built-ins back in with `inlineVariables`).
const isBuiltInPreset = $derived(
  (availablePresets as string[]).includes(config.preset),
);
const useInlineVariables = $derived(inlineVariables ?? !isBuiltInPreset);

// Convert to style string — full variable set only on the runtime path;
// otherwise just the explicit accent/overrides so they layer over static CSS.
const styleString = $derived.by(() => {
  const declarations: string[] = [];

  if (useInlineVariables) {
    for (const [key, value] of Object.entries(
      generateThemeVariables(currentTheme, isDark),
    )) {
      declarations.push(`${key}: ${value}`);
    }
  }

  // Border radius: only a non-default choice is emitted, so `md` keeps the
  // preset's own control radius from the static stylesheet.
  if (config.borderRadius && config.borderRadius !== 'md') {
    const [control, small] = CONTROL_RADIUS[config.borderRadius];
    declarations.push(
      `--smrt-control-radius: ${control}`,
      `--smrt-control-radius-small: ${small}`,
    );
  }

  // Primary colour override: the whole derived set for the resolved scheme so
  // on-primary / container / focus / accent never stay mismatched.
  if (config.primaryColor) {
    try {
      for (const [key, value] of Object.entries(
        derivePrimaryOverrides(config.primaryColor, resolvedScheme),
      )) {
        declarations.push(`${key}: ${value}`);
      }
    } catch {
      // Unparseable colour (e.g. a named colour): keep the single variable.
      declarations.push(`--smrt-color-primary: ${config.primaryColor}`);
    }
  }

  if (config.density !== undefined) {
    declarations.push(
      `--smrt-control-target-min: ${config.density === 'touch' ? 'var(--smrt-touch-target-min)' : '0px'}`,
    );
  }

  // Forced colors (#3908): system palette beats every preset, runtime theme and
  // primaryColor value; explicit `overrides` still win below.
  if (resolvedContrast === 'forced') {
    for (const [key, value] of Object.entries(FORCED_COLORS_TOKENS)) {
      declarations.push(`${key}: ${value}`);
    }
  }

  // Apply custom overrides
  for (const [key, value] of Object.entries(config.overrides ?? {})) {
    declarations.push(`${key}: ${value}`);
  }

  return declarations.join('; ');
});

// Theme state for context
const themeState = $derived<ThemeStateType>({
  preset: config.preset,
  colorScheme: config.colorScheme,
  resolvedScheme,
  isDark,
  contrast: resolvedContrast,
  isChangingScheme,
  config,
  theme: currentTheme,
});

// Context methods
function setPreset(newPreset: ThemePreset): void {
  config.preset = newPreset;
  persistConfig();
}

function setColorScheme(scheme: ColorScheme): void {
  config.colorScheme = scheme;
  persistConfig();
}

function toggleColorScheme(): void {
  const newScheme = isDark ? 'light' : 'dark';
  setColorScheme(newScheme);
}

function updateConfig(updates: Partial<ThemeConfig>): void {
  config = { ...config, ...updates };
  persistConfig();
}

// Persistence
function persistConfig(): void {
  if (!config.persist || typeof localStorage === 'undefined') return;

  try {
    const data = JSON.stringify({
      preset: config.preset,
      colorScheme: config.colorScheme,
      borderRadius: config.borderRadius,
      ...(config.density ? { density: config.density } : {}),
      ...(config.contrast && config.contrast !== 'auto'
        ? { contrast: config.contrast }
        : {}),
    });
    localStorage.setItem(config.storageKey!, data);
  } catch {
    // Ignore storage errors (e.g., private mode, quota exceeded)
  }
}

function loadPersistedConfig(): void {
  if (!config.persist || typeof localStorage === 'undefined') return;

  try {
    const stored = localStorage.getItem(config.storageKey!);
    if (stored) {
      const data = JSON.parse(stored) as unknown;
      if (!data || typeof data !== 'object') return;
      const persisted = data as Record<string, unknown>;
      if (
        typeof persisted.preset === 'string' &&
        isValidPreset(persisted.preset)
      ) {
        config.preset = persisted.preset;
      }
      if (
        persisted.colorScheme === 'light' ||
        persisted.colorScheme === 'dark' ||
        persisted.colorScheme === 'system'
      ) {
        config.colorScheme = persisted.colorScheme;
      }
      if (
        persisted.borderRadius === 'none' ||
        persisted.borderRadius === 'sm' ||
        persisted.borderRadius === 'md' ||
        persisted.borderRadius === 'lg' ||
        persisted.borderRadius === 'xl' ||
        persisted.borderRadius === 'full'
      ) {
        config.borderRadius = persisted.borderRadius;
      }
      if (
        persisted.density === 'comfortable' ||
        persisted.density === 'touch'
      ) {
        config.density = persisted.density;
      }
      if (persisted.contrast === 'standard' || persisted.contrast === 'more') {
        config.contrast = persisted.contrast;
      }
    }
  } catch {
    // Ignore storage errors (e.g., corrupted data, JSON parse errors)
  }
}

// Create context
const context: ThemeContext = {
  get state() {
    return themeState;
  },
  setPreset,
  setColorScheme,
  toggleColorScheme,
  updateConfig,
};

// Resolved before this provider registers itself: a parent context means this
// provider is nested, so it themes its own subtree only unless told otherwise.
// Fixed at creation: a provider does not move between root and nested.
const writesDocument = untrack(
  () => (scope ?? (tryGetThemeContext() ? 'local' : 'document')) === 'document',
);

setThemeContext(context);

onMount(() => {
  // Check system preference
  if (typeof window !== 'undefined') {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    systemPrefersDark = mediaQuery.matches;

    // Listen for system preference changes
    const handler = (e: MediaQueryListEvent) => {
      systemPrefersDark = e.matches;
    };
    mediaQuery.addEventListener('change', handler);

    // Contrast preferences (guarded: matchMedia stubs may omit these queries)
    const moreQuery = window.matchMedia('(prefers-contrast: more)');
    const forcedQuery = window.matchMedia('(forced-colors: active)');
    systemContrastMore = !!moreQuery?.matches;
    systemForcedColors = !!forcedQuery?.matches;
    const moreHandler = (e: MediaQueryListEvent) => {
      systemContrastMore = e.matches;
    };
    const forcedHandler = (e: MediaQueryListEvent) => {
      systemForcedColors = e.matches;
    };
    moreQuery?.addEventListener?.('change', moreHandler);
    forcedQuery?.addEventListener?.('change', forcedHandler);

    // Load persisted preferences
    loadPersistedConfig();

    mounted = true;

    return () => {
      mediaQuery.removeEventListener('change', handler);
      moreQuery?.removeEventListener?.('change', moreHandler);
      forcedQuery?.removeEventListener?.('change', forcedHandler);
      if (schemeTimer) clearTimeout(schemeTimer);
    };
  }
});

// Update document classes and attributes
$effect(() => {
  if (typeof document !== 'undefined' && mounted && writesDocument) {
    const html = document.documentElement;

    // Dark mode class for Tailwind/tailwindcss-dark-mode compatibility
    html.classList.toggle('dark', isDark);

    // Theme data attributes
    html.setAttribute('data-theme', config.preset);
    html.setAttribute('data-color-scheme', resolvedScheme);

    // Color scheme for browser UI
    html.style.colorScheme = resolvedScheme;

    // Contrast / density contract (themeScript stamps the same pre-paint)
    html.setAttribute('data-contrast', resolvedContrast);
    html.toggleAttribute('data-forced-colors', resolvedContrast === 'forced');
    if (config.density) html.setAttribute('data-density', config.density);
    else html.removeAttribute('data-density');
  }
});

// Scheme crossfade: flag the root for one --smrt-duration-scheme after the
// resolved scheme CHANGES post-mount (never on first paint, never under
// prefers-reduced-motion) so base.css/components can transition colours.
const FALLBACK_SCHEME_MS = 250;
let schemeTimer: ReturnType<typeof setTimeout> | undefined;
let lastScheme: 'light' | 'dark' | undefined;

function parseDurationMs(value: string): number | undefined {
  const m = /^\s*(\d*\.?\d+)(ms|s)\s*$/.exec(value);
  if (!m) return undefined;
  return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
}

function schemeDurationMs(): number {
  const style = getComputedStyle(rootEl ?? document.documentElement);
  return (
    parseDurationMs(style.getPropertyValue('--smrt-duration-scheme')) ??
    parseDurationMs(style.getPropertyValue('--smrt-duration-medium1')) ??
    FALLBACK_SCHEME_MS
  );
}

$effect(() => {
  const scheme = resolvedScheme;
  if (!mounted || typeof document === 'undefined') return;
  const previous = lastScheme;
  lastScheme = scheme;
  if (previous === undefined || previous === scheme) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
  const ms = untrack(schemeDurationMs);
  isChangingScheme = true;
  if (schemeTimer) clearTimeout(schemeTimer);
  schemeTimer = setTimeout(() => {
    isChangingScheme = false;
    schemeTimer = undefined;
  }, ms);
});

$effect(() => {
  if (typeof document === 'undefined' || !mounted || !writesDocument) return;
  document.documentElement.toggleAttribute(
    'data-smrt-theme-changing',
    isChangingScheme,
  );
});

// Sync props to state — but only on actual prop changes. config is seeded
// from the initial props above and onMount applies persisted preferences, so
// re-asserting the initial prop values here would clobber the persisted
// choice ($effect order vs onMount is not a safe thing to rely on).
let prevPreset = untrack(() => preset);
let prevColorScheme = untrack(() => colorScheme);
let prevPrimaryColor = untrack(() => primaryColor);
let prevBorderRadius = untrack(() => borderRadius);
let prevDensity = untrack(() => density);
let prevContrast = untrack(() => contrast);
let prevOverrides = untrack(() => overrides);
let prevPersist = untrack(() => persist);
let prevStorageKey = untrack(() => storageKey);
let rootEl = $state<HTMLElement | undefined>();

$effect(() => {
  if (preset !== prevPreset) {
    prevPreset = preset;
    untrack(() => {
      config.preset = preset;
    });
  }
});

$effect(() => {
  if (colorScheme !== prevColorScheme) {
    prevColorScheme = colorScheme;
    untrack(() => {
      config.colorScheme = colorScheme;
    });
  }
});

$effect(() => {
  if (primaryColor !== prevPrimaryColor) {
    prevPrimaryColor = primaryColor;
    untrack(() => {
      if (primaryColor !== undefined) {
        config.primaryColor = primaryColor;
      }
    });
  }
});

$effect(() => {
  if (borderRadius !== prevBorderRadius) {
    prevBorderRadius = borderRadius;
    untrack(() => {
      config.borderRadius = borderRadius;
    });
  }
});

$effect(() => {
  if (density !== prevDensity) {
    prevDensity = density;
    untrack(() => {
      config.density = density;
    });
  }
});

$effect(() => {
  if (contrast !== prevContrast) {
    prevContrast = contrast;
    untrack(() => {
      config.contrast = contrast;
    });
  }
});

// Same guard as above (#3873): writing `config.x` reads `config`, so an
// unguarded sync re-ran on every updateConfig() and wrote the prop back over
// the programmatic value.
$effect(() => {
  if (overrides !== prevOverrides) {
    prevOverrides = overrides;
    untrack(() => {
      config.overrides = overrides;
    });
  }
});

$effect(() => {
  if (persist !== prevPersist) {
    prevPersist = persist;
    untrack(() => {
      config.persist = persist;
    });
  }
});

$effect(() => {
  if (storageKey !== prevStorageKey) {
    prevStorageKey = storageKey;
    untrack(() => {
      config.storageKey = storageKey;
    });
  }
});
</script>

<svelte:head>
  <!-- Declares the smrt cascade layer order before any layered component rule (#3823). -->
  <svelte:element this={'style'} id="smrt-cascade-layers">{SMRT_CASCADE_LAYERS_CSS}</svelte:element>
</svelte:head>

<div
  bind:this={rootEl}
  class="smrt-theme-root"
  class:dark={isDark}
  class:no-paint={!paintSurface}
  class:smrt-theme-glass={config.preset === 'glass'}
  style={styleString || undefined}
  data-theme={config.preset}
  data-color-scheme={resolvedScheme}
  data-contrast={resolvedContrast}
  data-forced-colors={resolvedContrast === 'forced' ? '' : undefined}
  data-density={config.density}
  data-smrt-theme-changing={isChangingScheme ? '' : undefined}
  data-smrt-component="ThemeProvider"
>
  {@render children()}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-theme-root {
    /* Ensure theme variables cascade properly */
    /* Note: Using block display instead of contents so styles apply correctly */
    display: block;
    color: var(--smrt-color-on-background);
    background-color: var(--smrt-color-background);
    font-family: var(--smrt-font-family);
  }

  .smrt-theme-root.no-paint {
    color: inherit;
    background-color: transparent;
    font-family: inherit;
  }

  /* HappyVertical ("Day Shift") focus indicator (#2318).
   * The brand focus ring is part of the preset, so it has to travel on BOTH
   * delivery paths: this mirrors the identical rule in
   * themes/styles/happyvertical.css so an app using ThemeProvider without
   * importing the static stylesheet still gets it. Component-scoped
   * :focus-visible rules are more specific and continue to win. */
  :global([data-theme='happyvertical'] :focus-visible) {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }
}
</style>
