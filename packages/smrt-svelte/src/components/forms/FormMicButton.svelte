<script lang="ts">
import { useAppState } from '../../hooks/useAppState.svelte.js';
import { tryGetFormContext } from '../../state/form-context.js';

export interface Props {
  /** Size of the mic icon */
  size?: number;
  /** Additional CSS class */
  class?: string;
}

let { size = 16, class: className = '' }: Props = $props();

const app = useAppState();
const formContext = tryGetFormContext();

const isSmrt = $derived(app.state.mode === 'smrt');

// Use $state + $effect to track context values since getters don't propagate reactivity
let isListening = $state(false);
let isExtracting = $state(false);

// Poll the context state - this will update when the form state changes
// Using a fast polling interval (50ms) to reduce UI lag
$effect(() => {
  const checkState = () => {
    if (formContext) {
      const newListening = formContext.isFormListening;
      const newExtracting = formContext.isExtracting;
      // Only log on change to reduce noise
      if (newListening !== isListening || newExtracting !== isExtracting) {
      }
      isListening = newListening;
      isExtracting = newExtracting;
    }
  };

  // Check immediately
  checkState();

  // Set up fast polling interval for state changes
  const interval = setInterval(checkState, 50);

  return () => clearInterval(interval);
});

function handleClick() {
  formContext?.toggleListening();
}
</script>

{#if isSmrt && formContext}
  <span
    class="form-mic-icon {className}"
    class:listening={isListening}
    class:extracting={isExtracting}
    onclick={handleClick}
    onkeydown={(e) => e.key === 'Enter' && handleClick()}
    role="button"
    tabindex="0"
    aria-label={isListening ? 'Stop listening' : 'Click to speak'}
  >
    {#if isExtracting}
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        class="spinner"
      >
        <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/>
      </svg>
    {:else}
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" x2="12" y1="19" y2="22"/>
      </svg>
    {/if}
    {#if isListening}
      <span class="tooltip">Speak to fill all fields. Click again to stop.</span>
    {/if}
  </span>
{/if}

<style>
  .form-mic-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    color: var(--smrt-color-on-surface-variant, #9ca3af);
    cursor: pointer;
    transition: color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
    vertical-align: middle;
    margin-left: 0.5rem;
  }

  .form-mic-icon:hover {
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .form-mic-icon.listening {
    color: var(--smrt-color-primary, #22c55e);
    animation: pulse 1.5s ease-in-out infinite;
  }

  .form-mic-icon.extracting {
    color: var(--smrt-color-primary, #22c55e);
  }

  .tooltip {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: var(--smrt-color-on-surface, #1f2937);
    color: white;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-normal, 400);
    border-radius: 0.375rem;
    white-space: nowrap;
    z-index: var(--smrt-z-index-tooltip, 1600);
    box-shadow: var(--smrt-elevation-2, 0 4px 6px -1px color-mix(in srgb, var(--smrt-color-shadow) 10%, transparent));
  }

  .tooltip::before {
    content: '';
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 6px solid transparent;
    border-bottom-color: var(--smrt-color-on-surface);
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  @media (prefers-reduced-motion: reduce) {
    .form-mic-icon.listening {
      animation: none;
    }
  }

  .spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
