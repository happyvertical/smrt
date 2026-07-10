<script lang="ts">
import Alert from './Alert.svelte';
import {
  toaster as defaultToaster,
  type Toast,
  type Toaster,
} from './toast.js';

export interface Props {
  toaster?: Toaster;
  position?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
  class?: string;
}
let {
  toaster = defaultToaster,
  position = 'bottom-end',
  class: className = '',
}: Props = $props();
let toasts = $state<Toast[]>([]);

$effect(() => toaster.subscribe((next) => (toasts = next)));

async function runAction(toast: Toast) {
  await toast.action?.run();
  toaster.dismiss(toast.id);
}
</script>

<section class="viewport viewport--{position} {className}" aria-label="Notifications" aria-live="polite">
  {#each toasts as toast (toast.id)}
    <Alert variant={toast.variant} title={toast.title} dismissible ondismiss={() => toaster.dismiss(toast.id)}>
      {toast.message}
      {#snippet action()}
        {#if toast.action}<button type="button" onclick={() => runAction(toast)}>{toast.action.label}</button>{/if}
      {/snippet}
    </Alert>
  {/each}
</section>

<style>
  .viewport { position: fixed; z-index: var(--smrt-z-index-toast, 1200); display: grid; width: min(24rem, calc(100vw - 2 * var(--smrt-spacing-4))); gap: var(--smrt-spacing-2); pointer-events: none; }
  .viewport :global(.alert) { pointer-events: auto; box-shadow: var(--smrt-elevation-3); }
  .viewport--top-start { top: var(--smrt-spacing-4); left: var(--smrt-spacing-4); }
  .viewport--top-end { top: var(--smrt-spacing-4); right: var(--smrt-spacing-4); }
  .viewport--bottom-start { bottom: var(--smrt-spacing-4); left: var(--smrt-spacing-4); }
  .viewport--bottom-end { right: var(--smrt-spacing-4); bottom: var(--smrt-spacing-4); }
  button { padding: var(--smrt-spacing-1) var(--smrt-spacing-2); border: 1px solid currentColor; border-radius: var(--smrt-radius-small); background: transparent; color: inherit; font: inherit; cursor: pointer; }
</style>
