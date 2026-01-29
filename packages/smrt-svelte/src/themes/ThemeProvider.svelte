<script lang="ts">
import type { Snippet } from 'svelte';
import { onMount } from 'svelte';
import {
  setThemeContext,
  type ThemeContext,
  type ThemeState as ThemeStateType,
} from './context.svelte.js';
import { generateThemeVariables } from './css-generator.js';
import { getTheme } from './registry.js';
import type { ColorScheme, Theme, ThemeConfig, ThemePreset } from './types.js';
import { defaultThemeConfig } from './types.js';

interface Props {
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
  /** Persist preferences to localStorage */
  persist?: boolean;
  /** Storage key for persistence */
  storageKey?: string;
  /** Content */
  children: Snippet;
}

let {
  preset = defaultThemeConfig.preset,
  colorScheme = defaultThemeConfig.colorScheme,
  primaryColor,
  borderRadius = defaultThemeConfig.borderRadius,
  overrides = {},
  persist = defaultThemeConfig.persist,
  storageKey = defaultThemeConfig.storageKey,
  children,
}: Props = $props();

// Internal state
let config = $state<ThemeConfig>({
  preset,
  colorScheme,
  primaryColor,
  borderRadius,
  overrides,
  persist,
  storageKey,
});

let systemPrefersDark = $state(false);
let mounted = $state(false);

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

// Generate CSS variables - using $derived with immediate value
const cssVariables = $derived.by(() => {
  const vars = generateThemeVariables(currentTheme, isDark);

  // Apply primary color override
  if (config.primaryColor) {
    vars['--smrt-color-primary'] = config.primaryColor;
    // Recalculate dependent colors would go here in a full implementation
  }

  // Apply border radius override
  if (config.borderRadius && config.borderRadius !== 'md') {
    // The border radius values are already in CSS vars, but we could
    // add logic here to override specific radius values
  }

  // Apply custom overrides
  return { ...vars, ...config.overrides };
});

// Convert to style string
const styleString = $derived.by(() => {
  return Object.entries(cssVariables)
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ');
});

// Theme state for context
const themeState = $derived<ThemeStateType>({
  preset: config.preset,
  colorScheme: config.colorScheme,
  resolvedScheme,
  isDark,
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
      const data = JSON.parse(stored);
      if (data.preset) config.preset = data.preset;
      if (data.colorScheme) config.colorScheme = data.colorScheme;
      if (data.borderRadius) config.borderRadius = data.borderRadius;
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

    // Load persisted preferences
    loadPersistedConfig();

    mounted = true;

    return () => {
      mediaQuery.removeEventListener('change', handler);
    };
  }
});

// Update document classes and attributes
$effect(() => {
  if (typeof document !== 'undefined' && mounted) {
    const html = document.documentElement;

    // Dark mode class for Tailwind/tailwindcss-dark-mode compatibility
    html.classList.toggle('dark', isDark);

    // Theme data attributes
    html.setAttribute('data-theme', config.preset);
    html.setAttribute('data-color-scheme', resolvedScheme);

    // Color scheme for browser UI
    html.style.colorScheme = resolvedScheme;
  }
});

// Sync props to state
$effect(() => {
  config.preset = preset;
});

$effect(() => {
  config.colorScheme = colorScheme;
});

$effect(() => {
  if (primaryColor !== undefined) {
    config.primaryColor = primaryColor;
  }
});

$effect(() => {
  config.borderRadius = borderRadius;
});

// Sync overrides prop to state
$effect(() => {
  config.overrides = overrides;
});
</script>

<div
  class="smrt-theme-root"
  class:dark={isDark}
  class:smrt-theme-glass={config.preset === 'glass'}
  style={styleString}
  data-theme={config.preset}
  data-color-scheme={resolvedScheme}
>
  {@render children()}
</div>

<style>
  .smrt-theme-root {
    /* Ensure theme variables cascade properly */
    /* Note: Using block display instead of contents so styles apply correctly */
    display: block;
    color: var(--smrt-color-on-background);
    background-color: var(--smrt-color-background);
    font-family: var(--smrt-font-family);
  }

  /* Glass theme specific base styles */
  :global(.smrt-theme-glass) {
    --smrt-glass-surface: var(--smrt-color-surface);
    --smrt-glass-border: var(--smrt-color-outline);
  }
</style>
