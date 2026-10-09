<script lang="ts">
import { formatSize } from '../assistant/models.ts';
import type { VoiceSession } from '../assistant/voice.svelte.ts';

interface VoiceTypingProps {
  voice: VoiceSession;
}

let { voice }: VoiceTypingProps = $props();

const megabytes = $derived(Math.round(voice.size / 1_000_000));
const percent = $derived(Math.round(voice.progress * 100));
const visible = $derived(
  voice.status === 'offer' ||
    voice.status === 'downloading' ||
    voice.status === 'error',
);
</script>

{#if visible}
  <div class="voice" role="group" aria-label="Voice typing">
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2Z"
      />
    </svg>
    <div class="text">
      {#if voice.status === 'downloading'}
        <span role="status" aria-live="polite">
          {voice.cached ? 'Turning on voice typing' : 'Downloading speech model'}
          {percent}%
        </span>
        <progress max="100" value={percent} aria-label="Speech model download"
          >{percent}%</progress
        >
      {:else if voice.status === 'error'}
        <span class="error" role="alert"
          >Voice typing could not start: {voice.error}</span
        >
      {:else if voice.cached}
        <span>
          The speech model is already on this device. Turn on voice typing to
          talk to the assistant?
        </span>
      {:else}
        <span>
          Your browser can't do voice typing on its own. Download a {formatSize(
            megabytes,
          )} speech model to talk to the assistant?
        </span>
      {/if}
    </div>
    <div class="actions">
      {#if voice.status === 'downloading'}
        <button type="button" onclick={() => voice.cancel()}>Cancel</button>
      {:else}
        <button type="button" onclick={() => void voice.enable()}>
          {voice.status === 'error'
            ? 'Try again'
            : voice.cached
              ? 'Turn on'
              : 'Download'}
        </button>
        <button type="button" onclick={() => voice.dismiss()}>Not now</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .voice {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-2) var(--smrt-spacing-4);
    min-width: 0;
    color: var(--smrt-color-on-surface-variant);
    overflow-wrap: anywhere;
  }

  .icon {
    flex: none;
    width: 1.25rem;
    height: 1.25rem;
    fill: currentColor;
  }

  .text {
    flex: 1 1 14rem;
    display: grid;
    gap: var(--smrt-spacing-1);
    min-width: 0;
  }

  .actions {
    display: flex;
    gap: var(--smrt-spacing-2);
  }

  progress {
    width: 100%;
  }

  .error {
    color: var(--smrt-color-error);
  }
</style>
