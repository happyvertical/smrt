<script lang="ts">
import type { Snippet } from 'svelte';

export interface Props {
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  children?: Snippet;
  action?: Snippet;
  dismissible?: boolean;
  ondismiss?: () => void;
  class?: string;
}

let {
  variant = 'info',
  title,
  children,
  action,
  dismissible = false,
  ondismiss,
  class: className = '',
}: Props = $props();
const role = $derived(
  variant === 'error' || variant === 'warning' ? 'alert' : 'status',
);
</script>

<div class="alert alert--{variant} {className}" {role}>
  <span class="marker" aria-hidden="true"></span>
  <div class="content">
    {#if title}<strong>{title}</strong>{/if}
    {#if children}<div class="message">{@render children()}</div>{/if}
  </div>
  {#if action}<div class="action">{@render action()}</div>{/if}
  {#if dismissible}
    <button type="button" class="dismiss" aria-label="Dismiss" onclick={ondismiss}>×</button>
  {/if}
</div>

<style>
  .alert { --alert-color: var(--smrt-color-primary); display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: start; gap: var(--smrt-spacing-3); padding: var(--smrt-spacing-3) var(--smrt-spacing-4); border: 1px solid color-mix(in srgb, var(--alert-color) 35%, var(--smrt-color-outline-variant)); border-radius: var(--smrt-radius-medium); background: color-mix(in srgb, var(--alert-color) 8%, var(--smrt-color-surface)); color: var(--smrt-color-on-surface); }
  .alert--success { --alert-color: var(--smrt-color-success, #2e7d32); }
  .alert--warning { --alert-color: var(--smrt-color-warning, #a45b00); }
  .alert--error { --alert-color: var(--smrt-color-error); }
  .marker { width: .65rem; height: .65rem; margin-top: .4rem; border-radius: 50%; background: var(--alert-color); }
  .content { min-width: 0; }
  strong { display: block; font: var(--smrt-typography-title-small-font); }
  .message { color: var(--smrt-color-on-surface-variant); }
  .action { align-self: center; }
  .dismiss { width: 2rem; height: 2rem; margin: -.35rem; border: 0; border-radius: var(--smrt-radius-full); background: transparent; color: inherit; font-size: 1.25rem; cursor: pointer; }
  .dismiss:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
  .dismiss:focus-visible { outline: 2px solid var(--smrt-color-primary); }
</style>
