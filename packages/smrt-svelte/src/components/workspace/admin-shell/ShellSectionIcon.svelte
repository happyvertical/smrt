<script lang="ts">
/**
 * Draws a section or entry icon by name: a built-in shell icon
 * (`SHELL_ICON_PATHS`) as an inline SVG, else the host's `iconComponent`, else
 * the name itself as text. Decorative (`aria-hidden`); callers name the
 * control.
 */
import type { Component } from 'svelte';
import { isShellIconName, SHELL_ICON_PATHS } from './shell-icons.js';

interface Props {
  /** Icon name: a built-in shell icon, else whatever `iconComponent` knows. */
  name: string;
  /** Edge length in pixels (default 18). */
  size?: number;
  /** Renders names that are not built-in shell icons. */
  iconComponent?: Component<{ name: string; size?: number }>;
}

let { name, size = 18, iconComponent: Host }: Props = $props();
</script>

<span class="smrt-shell-section-icon" aria-hidden="true">
  {#if isShellIconName(name)}
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" focusable="false"><path d={SHELL_ICON_PATHS[name]} /></svg>
  {:else if Host}
    <Host {name} {size} />
  {:else}
    {name}
  {/if}
</span>

<style>
  .smrt-shell-section-icon { display: inline-grid; place-items: center; flex: 0 0 auto; }
</style>
