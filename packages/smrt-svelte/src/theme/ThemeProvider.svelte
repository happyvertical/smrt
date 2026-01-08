<script lang="ts">
import type { Snippet } from 'svelte';
import { onMount } from 'svelte';
import {
  setThemeContext,
  type ThemeContext,
  type ThemeState,
} from './context.js';
import {
  type ColorScheme,
  defaultThemeConfig,
  generateThemeVariables,
  type ThemeConfig,
} from './tokens.js';

interface Props {
  /** Initial color scheme */
  colorScheme?: ColorScheme;
  /** Primary color override */
  primaryColor?: string;
  /** Border radius scale */
  borderRadius?: ThemeConfig['borderRadius'];
  /** Custom CSS variable overrides */
  overrides?: Record<string, string>;
  /** Persist preference to localStorage */
  persist?: boolean;
  /** Storage key for persistence */
  storageKey?: string;
  /** Content */
  children: Snippet;
}

let {
  colorScheme = 'system',
  primaryColor,
  borderRadius = 'md',
  overrides = {},
  persist = true,
  storageKey = 'smrt-theme',
  children,
}: Props = $props();

// Internal state
let config = $state<ThemeConfig>({
  colorScheme,
  primaryColor: primaryColor ?? defaultThemeConfig.primaryColor,
  borderRadius,
  overrides,
});

let systemPrefersDark = $state(false);
let mounted = $state(false);

// Resolved scheme (never 'system')
const resolvedScheme = $derived<'light' | 'dark'>(
  config.colorScheme === 'system'
    ? systemPrefersDark
      ? 'dark'
      : 'light'
    : config.colorScheme,
);

const isDark = $derived(resolvedScheme === 'dark');

// Generate CSS variables
const cssVariables = $derived(() => {
  const vars = generateThemeVariables(isDark);

  // Override primary color if specified
  if (
    config.primaryColor &&
    config.primaryColor !== defaultThemeConfig.primaryColor
  ) {
    vars['--smrt-color-primary'] = config.primaryColor;
  }

  // Apply custom overrides
  return { ...vars, ...config.overrides };
});

// Create style string
const styleString = $derived(() => {
  const vars = cssVariables();
  return Object.entries(vars)
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ');
});

// Theme state for context
const themeState = $derived<ThemeState>({
  colorScheme: config.colorScheme,
  resolvedScheme,
  isDark,
  config,
});

// Context methods
function setColorScheme(scheme: ColorScheme): void {
  config.colorScheme = scheme;
  if (persist && typeof localStorage !== 'undefined') {
    localStorage.setItem(storageKey, scheme);
  }
}

function toggleColorScheme(): void {
  const newScheme = isDark ? 'light' : 'dark';
  setColorScheme(newScheme);
}

function updateConfig(updates: Partial<ThemeConfig>): void {
  config = { ...config, ...updates };
}

// Create context
const context: ThemeContext = {
  get state() {
    return themeState;
  },
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

    // Load persisted preference
    if (persist) {
      const stored = localStorage.getItem(storageKey);
      if (stored && ['light', 'dark', 'system'].includes(stored)) {
        config.colorScheme = stored as ColorScheme;
      }
    }

    mounted = true;

    return () => {
      mediaQuery.removeEventListener('change', handler);
    };
  }
});

// Update document class for global dark mode styling
$effect(() => {
  if (typeof document !== 'undefined' && mounted) {
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.setAttribute('data-theme', resolvedScheme);
  }
});
</script>

<div class="smrt-theme-root" class:dark={isDark} style={styleString()} data-theme={resolvedScheme}>
  {@render children()}
</div>

<style>
  .smrt-theme-root {
    /* Ensure theme variables cascade to all children */
    display: contents;
  }
</style>
