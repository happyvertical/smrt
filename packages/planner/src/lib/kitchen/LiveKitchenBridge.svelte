<script lang="ts">
import { onMount } from 'svelte';
import { createHostSession } from '../planner/host/session.svelte.ts';
import { callLiveKitchen, type LiveKitchenBinding } from './live.ts';

let {
  binding,
  onlock,
}: { binding: LiveKitchenBinding; onlock?: (locked: boolean) => void } =
  $props();
const session = createHostSession((name, args) =>
  callLiveKitchen(binding, name, args),
);

$effect(() => {
  onlock?.(session.locked);
  return () => onlock?.(false);
});

onMount(() => {
  const stop = session.mount();
  void session.connect(binding.planId);
  const timer = setInterval(() => {
    if (
      !session.busy &&
      !session.retryable &&
      document.visibilityState === 'visible'
    ) {
      void session.connect(binding.planId);
    }
  }, 1500);
  return () => {
    clearInterval(timer);
    stop();
  };
});
</script>

{#if session.error}
  <p role="alert" class="bridge-error">Kitchen live preview: {session.error}</p>
{/if}
{#if session.preservedDraft && !session.retryable}
  <details class="bridge-preserved">
    <summary>Preserved edit</summary>
    <textarea readonly aria-label="Preserved cookbook edit" value={JSON.stringify(session.preservedDraft, null, 2)}></textarea>
    <button type="button" onclick={() => session.dismissPreservedDraft()}>Dismiss preserved edit</button>
  </details>
{/if}
{#if session.retryable}
  <div class="bridge-backdrop" aria-hidden="true"></div>
  <div class="bridge-recovery" role="dialog" aria-modal="true" aria-labelledby="bridge-recovery-title">
    <h2 id="bridge-recovery-title">Kitchen edit needs attention</h2>
    <p>The app is paused until this edit is retried. The same command will be sent so Kitchen can safely recognize a previous success.</p>
    {#if session.draft}
      <label for="bridge-draft">Preserved cookbook edit</label>
      <textarea id="bridge-draft" readonly value={JSON.stringify(session.draft, null, 2)}></textarea>
    {/if}
    <button type="button" disabled={session.busy} onclick={() => session.retry()}>Retry same edit</button>
  </div>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .bridge-error { margin: 0; padding: var(--smrt-spacing-2, .5rem) var(--smrt-spacing-4, 1rem); color: var(--smrt-color-on-error-container, #b91c1c); background: var(--smrt-color-error-container, #fef2f2); }
  .bridge-backdrop { position: fixed; inset: 0; z-index: 9998; background: rgb(0 0 0 / .45); }
  .bridge-recovery { position: fixed; z-index: 9999; inset-inline: max(1rem, calc((100vw - 32rem) / 2)); top: 15vh; display: grid; gap: .75rem; padding: 1.5rem; border-radius: var(--smrt-radius-large, .75rem); background: var(--smrt-surface-raised, white); color: var(--smrt-color-on-surface, black); box-shadow: var(--smrt-elevation-4); }
  .bridge-recovery h2, .bridge-recovery p { margin: 0; }
  .bridge-preserved { padding: var(--smrt-spacing-2, .5rem) var(--smrt-spacing-4, 1rem); color: var(--smrt-color-on-error-container, #b91c1c); background: var(--smrt-color-error-container, #fef2f2); }
  .bridge-preserved textarea { width: 100%; min-height: 8rem; }
  .bridge-recovery textarea { min-height: 10rem; max-height: 35vh; width: 100%; }
}
</style>
