<script lang="ts">
import {
  getThemeContext,
  type ThemePreset,
} from '@happyvertical/smrt-ui/themes';
import { onMount } from 'svelte';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import {
  containCustomCss,
  customCssApproved,
  customCssDisabled,
  shellScopeOf,
} from '../theme/custom-css.svelte.ts';
import { resolveTheme } from '../theme/runtime.ts';
import type { ColorSchemeSetting } from '../theme/theme.ts';

// The app document owns the theme. This applies it to the shell's
// ThemeProvider once the saved document is read, and reads back a change made
// through the provider's own controls (ThemeSwitcher, ColorSchemeToggle) so
// that it is saved with the document.
const context = getThemeContext();
let {
  deferInitial = false,
  presetOverride,
}: { deferInitial?: boolean; presetOverride?: string } = $props();
// A hosted shell's own provider reads browser-local preferences on mount;
// deferring the first apply lets the plan's theme win over them.
let ready = $state(false);
onMount(() => {
  if (!deferInitial) {
    ready = true;
    return;
  }
  const timer = setTimeout(() => {
    ready = true;
  }, 0);
  return () => clearTimeout(timer);
});

// What this bridge last told the provider, to tell its own writes from a
// person's. Null until the document has been applied once.
let applied: { preset: string; colorScheme: ColorSchemeSetting } | null = null;

// Document -> provider.
$effect(() => {
  if (!cookbookStore.loaded || !ready) return;
  const wanted = resolveTheme(cookbookStore.theme);
  if (presetOverride) wanted.preset = presetOverride;
  if (
    applied?.preset === wanted.preset &&
    applied.colorScheme === wanted.colorScheme
  ) {
    return;
  }
  applied = wanted;
  if (context.state.preset !== wanted.preset)
    context.setPreset(wanted.preset as ThemePreset);
  if (context.state.colorScheme !== wanted.colorScheme) {
    context.setColorScheme(wanted.colorScheme);
  }
});

// Provider -> document.
$effect(() => {
  const { preset, colorScheme } = context.state;
  if (!applied || !cookbookStore.loaded) return;
  const before = applied;
  if (preset !== before.preset) {
    applied = { ...before, preset };
    cookbookStore.setTheme({
      ...cookbookStore.theme,
      preset,
      fontFamily:
        cookbookStore.theme?.fontFamily ??
        cookbookStore.theme?.custom?.fontFamily,
      custom: undefined,
    });
  }
  if (colorScheme !== before.colorScheme) {
    applied = { ...(applied ?? before), colorScheme };
    cookbookStore.setTheme({ ...cookbookStore.theme, colorScheme });
  }
});

// Marks where this bridge sits, to find the one shell its CSS may style.
let anchor = $state<HTMLElement | null>(null);

// Each mounted Planner owns its own style element. Cookbook CSS is untrusted:
// it applies only once approved, contained to the app shell without external
// loads (see theme/custom-css), and `?styles=off` switches it off.
$effect(() => {
  if (typeof document === 'undefined' || !cookbookStore.loaded) return;
  const css = cookbookStore.theme?.customCss;
  if (!css || customCssDisabled(location.search) || !customCssApproved(css))
    return;
  const scope = shellScopeOf(anchor);
  if (!scope) return;
  const contained = containCustomCss(css, scope);
  if (!contained) return;
  const style = document.createElement('style');
  style.dataset.smrtPlannerCustom = '';
  style.textContent = contained;
  document.head.append(style);
  return () => style.remove();
});
</script>

<span bind:this={anchor} hidden data-smrt-planner-anchor></span>
