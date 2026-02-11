<script lang="ts">
import { useSTT } from '@happyvertical/smrt-svelte';
import { untrack } from 'svelte';
import DownloadProgress from './DownloadProgress.svelte';

export interface Props {
  /** Callback with transcribed text */
  onTranscription?: (text: string) => void;
  /** Language code (BCP-47) */
  language?: string;
  /** Enable continuous mode */
  continuous?: boolean;
  /** Size of the button */
  size?: 'sm' | 'md' | 'lg';
  /** Disabled state */
  disabled?: boolean;
}

const {
  onTranscription,
  language = 'en-US',
  continuous = false,
  size = 'md',
  disabled = false,
}: Props = $props();

const stt = useSTT();

// Track lastResult to call callback - use untrack to prevent infinite loops
let lastSeenResult = '';
$effect(() => {
  const result = stt.lastResult;
  if (result && result !== lastSeenResult) {
    lastSeenResult = result;
    untrack(() => {
      onTranscription?.(result);
    });
  }
});

async function handleToggle() {
  if (disabled) return;

  if (stt.isListening) {
    await stt.stop();
  } else {
    await stt.start({ language, continuous });
  }
}
</script>

<div class="voice-input" class:sm={size === 'sm'} class:lg={size === 'lg'}>
  {#if stt.isInitializing}
    <DownloadProgress
      progress={stt.downloadProgress ? {
        state: 'downloading',
        percent: stt.downloadProgress,
        bytesLoaded: 0,
        bytesTotal: 0
      } : null}
      label="Loading speech recognition..."
    />
  {:else if stt.error}
    <div class="error">
      <span class="error-icon">!</span>
      <span>{stt.error.message}</span>
    </div>
  {:else}
    <button
      type="button"
      class="mic-button"
      class:listening={stt.isListening}
      onclick={handleToggle}
      {disabled}
      aria-label={stt.isListening ? 'Stop listening' : 'Start listening'}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
      </svg>
    </button>
  {/if}
</div>

<style>
  .voice-input {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .mic-button {
    width: 3rem;
    height: 3rem;
    border-radius: 50%;
    border: none;
    background: #3b82f6;
    color: white;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .mic-button:hover:not(:disabled) {
    background: #2563eb;
    transform: scale(1.05);
  }

  .mic-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .mic-button.listening {
    background: #ef4444;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% {
      transform: scale(1);
      box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4);
    }
    50% {
      transform: scale(1.05);
      box-shadow: 0 0 0 10px rgba(239, 68, 68, 0);
    }
  }

  .mic-button svg {
    width: 1.5rem;
    height: 1.5rem;
  }

  /* Size variants */
  .sm .mic-button {
    width: 2.5rem;
    height: 2.5rem;
  }

  .sm .mic-button svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  .lg .mic-button {
    width: 4rem;
    height: 4rem;
  }

  .lg .mic-button svg {
    width: 2rem;
    height: 2rem;
  }

  .error {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 8px;
    color: #991b1b;
    font-size: 0.875rem;
  }

  .error-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: #ef4444;
    color: white;
    border-radius: 50%;
    font-weight: bold;
    font-size: 0.75rem;
  }
</style>
