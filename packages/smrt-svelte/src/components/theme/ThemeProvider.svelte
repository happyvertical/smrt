<script lang="ts">
import {
  elevationTokens,
  typographyTokens,
} from '../../utils/theme/typography.js';
import { setThemeContext, type ThemeMode } from './context.svelte.js';

interface Props {
  seed?: string;
  mode?: ThemeMode;
  children?: import('svelte').Snippet;
}

const { seed = '#6750A4', mode = 'system', children }: Props = $props();

function getInitialThemeState() {
  return { seed, mode };
}

const initialThemeState = getInitialThemeState();
const themeState = setThemeContext(
  initialThemeState.seed,
  initialThemeState.mode,
);

// Sync props to state if they change
$effect(() => {
  themeState.setSeed(seed);
});

$effect(() => {
  themeState.setMode(mode);
});

// Convert theme object to CSS variables string
const cssVariables = $derived.by(() => {
  const themeVars = Object.entries(themeState.theme)
    .map(([key, value]) => {
      // camelCase to kebab-case: onPrimary -> --md-sys-color-on-primary
      const kebab = key
        .replace(/([a-z0-9]|(?=[A-Z]))([A-Z])/g, '$1-$2')
        .toLowerCase();
      return `--md-sys-color-${kebab}: ${value};`;
    })
    .join('\n');

  const typoVars = Object.entries(typographyTokens)
    .map(([key, value]) => `${key}: ${value};`)
    .join('\n');

  const elevationVars = Object.entries(elevationTokens)
    .map(([key, value]) => `${key}: ${value};`)
    .join('\n');

  return [themeVars, typoVars, elevationVars].join('\n');
});
</script>

<div class="smrt-theme-provider" style={cssVariables}>
  {@render children?.()}
</div>

<style>
  .smrt-theme-provider {
    display: contents;
    /* Base typography and other global resets can go here later */
    color: var(--md-sys-color-on-background);
    background-color: var(--md-sys-color-background);
    font-family: Roboto, sans-serif;
  }
</style>
