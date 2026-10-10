<script lang="ts">
/**
 * Draws a section or entry icon by name: a built-in shell icon
 * (`SHELL_ICON_PATHS`) as an inline SVG, else the host's `iconComponent`, else
 * the name itself as text. Decorative (`aria-hidden`); callers name the
 * control.
 */
import type { Component } from 'svelte';
import {
  isShellIconName,
  SHELL_DEFAULT_SECTION_ICON,
  SHELL_ICON_PATHS,
} from './shell-icons.js';

const warned = new Set<string>();

interface Props {
  /** Icon name: a built-in shell icon, else whatever `iconComponent` knows. */
  name: string;
  /** Edge length in pixels (default 18). */
  size?: number;
  /** Renders names that are not built-in shell icons. */
  iconComponent?: Component<{ name: string; size?: number }>;
}

let { name, size = 18, iconComponent: Host }: Props = $props();

// An unknown name with no host renderer never prints as text: it falls back to
// the default glyph, with one dev warning per name.
const fallback = $derived(!isShellIconName(name) && !Host);
$effect(() => {
  if (
    fallback &&
    (import.meta as { env?: { DEV?: boolean } }).env?.DEV &&
    !warned.has(name)
  ) {
    warned.add(name);
    console.warn(
      `[smrt-svelte] Unknown shell icon "${name}"; using "${SHELL_DEFAULT_SECTION_ICON}".`,
    );
  }
});
</script>

<span class="smrt-shell-section-icon" aria-hidden="true">
  {#if isShellIconName(name)}
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" focusable="false"><path d={SHELL_ICON_PATHS[name]} /></svg>
  {:else if Host}
    <Host {name} {size} />
  {:else}
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" focusable="false"><path d={SHELL_ICON_PATHS[SHELL_DEFAULT_SECTION_ICON]} /></svg>
  {/if}
</span>

<style>
  .smrt-shell-section-icon { display: inline-grid; place-items: center; flex: 0 0 auto; }
</style>
