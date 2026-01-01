<script lang="ts">
  import { useAppState } from '../../hooks/useAppState.svelte.js';
  import { tryGetFormContext } from '../../state/form-context.js';

  interface Props {
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
  $effect(() => {
    const checkState = () => {
      if (formContext) {
        isListening = formContext.isFormListening;
        isExtracting = formContext.isExtracting;
      }
    };

    // Check immediately
    checkState();

    // Set up polling interval for state changes
    const interval = setInterval(checkState, 100);

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
    color: #9ca3af;
    cursor: pointer;
    transition: color 0.2s;
    vertical-align: middle;
    margin-left: 0.5rem;
  }

  .form-mic-icon:hover {
    color: #6b7280;
  }

  .form-mic-icon.listening {
    color: #22c55e;
    animation: pulse 1.5s ease-in-out infinite;
  }

  .form-mic-icon.extracting {
    color: #22c55e;
  }

  .tooltip {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: #1f2937;
    color: white;
    font-size: 0.75rem;
    font-weight: 400;
    border-radius: 0.375rem;
    white-space: nowrap;
    z-index: 50;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  }

  .tooltip::before {
    content: '';
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 6px solid transparent;
    border-bottom-color: #1f2937;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
