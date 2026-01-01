<script lang="ts">
/**
 * AI Loading Overlay Component
 *
 * Shows a full-screen overlay while AI models are being downloaded/initialized.
 * Designed to provide a smooth user experience during cold starts.
 */
import type { AILoadingState } from '../../state/app-state.js';
import { getAppStateContext } from '../../state/context.js';
import DownloadProgress from './DownloadProgress.svelte';

interface Props {
  /** Custom loading message */
  message?: string;
  /** Whether to show the overlay (auto-detected from state if not provided) */
  show?: boolean;
  /** Show detailed progress information */
  showDetails?: boolean;
  /** Allow dismissing the overlay */
  dismissible?: boolean;
  /** Custom CSS class */
  class?: string;
}

const {
  message,
  show,
  showDetails = true,
  dismissible = false,
  class: className = '',
}: Props = $props();

const appState = getAppStateContext();

// Determine if we should show the overlay
const isLoading = $derived(appState.isAILoading);
const aiLoading = $derived(appState.aiLoading);

// Use explicit show prop if provided, otherwise auto-detect
const shouldShow = $derived(show ?? isLoading);

// Get the current download progress for detailed display
const currentProgress = $derived(() => {
  if (aiLoading.currentAdapter?.includes('stt')) {
    return appState.state.ai.stt.downloadProgress;
  }
  if (aiLoading.currentAdapter?.includes('tts')) {
    return appState.state.ai.tts.downloadProgress;
  }
  if (aiLoading.currentAdapter?.includes('llm')) {
    return appState.state.ai.llm.downloadProgress;
  }
  return null;
});

let dismissed = $state(false);

function dismiss() {
  if (dismissible) {
    dismissed = true;
  }
}

function getPhaseLabel(phase: AILoadingState['phase']): string {
  switch (phase) {
    case 'checking':
      return 'Checking capabilities...';
    case 'downloading':
      return 'Downloading AI models...';
    case 'initializing':
      return 'Initializing AI...';
    case 'ready':
      return 'AI Ready';
    case 'error':
      return 'Error loading AI';
    default:
      return '';
  }
}
</script>

{#if shouldShow && !dismissed}
  <div
    class="ai-loading-overlay {className}"
    role="dialog"
    aria-modal="true"
    aria-labelledby="ai-loading-title"
  >
    <div class="overlay-backdrop"></div>

    <div class="overlay-content">
      <div class="loading-icon">
        {#if aiLoading.phase === 'error'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="icon error">
            <circle cx="12" cy="12" r="10" stroke-width="2" />
            <path d="M12 8v4m0 4h.01" stroke-width="2" stroke-linecap="round" />
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="icon spinner">
            <path
              d="M12 2a10 10 0 0 1 10 10"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        {/if}
      </div>

      <h2 id="ai-loading-title" class="title">
        {message ?? getPhaseLabel(aiLoading.phase)}
      </h2>

      {#if aiLoading.currentAdapter && showDetails}
        <p class="current-adapter">Loading: {aiLoading.currentAdapter}</p>
      {/if}

      {#if showDetails && currentProgress()}
        <div class="progress-container">
          <DownloadProgress
            progress={currentProgress()}
            label={aiLoading.message || 'Downloading...'}
            showPercent={true}
            showBytes={true}
          />
        </div>
      {:else if showDetails && aiLoading.overallProgress > 0}
        <div class="simple-progress">
          <div class="progress-bar">
            <div
              class="progress-fill"
              style:width="{aiLoading.overallProgress}%"
            ></div>
          </div>
          <span class="progress-text">{aiLoading.overallProgress}%</span>
        </div>
      {/if}

      {#if aiLoading.loaded.length > 0 && showDetails}
        <div class="loaded-adapters">
          {#each aiLoading.loaded as adapter}
            <span class="adapter-badge loaded">{adapter}</span>
          {/each}
        </div>
      {/if}

      {#if aiLoading.phase === 'error' && aiLoading.error}
        <p class="error-message">{aiLoading.error.message}</p>
      {/if}

      {#if dismissible}
        <button type="button" class="dismiss-btn" onclick={dismiss}>
          Continue without AI
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .ai-loading-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .overlay-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(4px);
  }

  .overlay-content {
    position: relative;
    background: white;
    border-radius: 16px;
    padding: 32px 40px;
    max-width: 400px;
    width: 90%;
    text-align: center;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  }

  .loading-icon {
    width: 48px;
    height: 48px;
    margin: 0 auto 16px;
  }

  .icon {
    width: 100%;
    height: 100%;
  }

  .icon.spinner {
    color: #3b82f6;
    animation: spin 1s linear infinite;
  }

  .icon.error {
    color: #ef4444;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .title {
    font-size: 1.25rem;
    font-weight: 600;
    color: #1f2937;
    margin: 0 0 8px;
  }

  .current-adapter {
    font-size: 0.875rem;
    color: #6b7280;
    margin: 0 0 16px;
  }

  .progress-container {
    margin: 16px 0;
  }

  .simple-progress {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 16px 0;
  }

  .progress-bar {
    flex: 1;
    height: 8px;
    background: #e5e7eb;
    border-radius: 4px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #3b82f6, #60a5fa);
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .progress-text {
    font-size: 0.875rem;
    font-weight: 600;
    color: #3b82f6;
    min-width: 40px;
  }

  .loaded-adapters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    margin-top: 16px;
  }

  .adapter-badge {
    font-size: 0.75rem;
    padding: 4px 10px;
    border-radius: 9999px;
    background: #dcfce7;
    color: #166534;
  }

  .error-message {
    font-size: 0.875rem;
    color: #ef4444;
    margin: 16px 0 0;
    padding: 12px;
    background: #fef2f2;
    border-radius: 8px;
  }

  .dismiss-btn {
    margin-top: 20px;
    padding: 10px 20px;
    font-size: 0.875rem;
    color: #6b7280;
    background: transparent;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .dismiss-btn:hover {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
</style>
