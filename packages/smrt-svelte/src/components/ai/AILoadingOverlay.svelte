<script lang="ts">
/**
 * AI Loading Overlay Component
 *
 * Shows a full-screen overlay while AI models are being downloaded/initialized.
 * Wraps the generic LoadingOverlay with AI-specific state management.
 */
import type { AILoadingState } from '../../state/app-state.js';
import { getAppStateContext } from '../../state/context.js';
import LoadingOverlay from '../feedback/LoadingOverlay.svelte';

interface Props {
  /** Custom loading message (overrides auto-detected phase label) */
  message?: string;
  /** Whether to show the overlay (auto-detected from state if not provided) */
  show?: boolean;
  /** Allow dismissing the overlay */
  dismissible?: boolean;
  /** Custom CSS class */
  class?: string;
  /** Callback when dismissed */
  ondismiss?: () => void;
}

const {
  message,
  show,
  dismissible = false,
  class: className = '',
  ondismiss,
}: Props = $props();

const appState = getAppStateContext();

// AI-specific state
const isLoading = $derived(appState.isAILoading);
const aiLoading = $derived(appState.aiLoading);

// Use explicit show prop if provided, otherwise auto-detect from AI state
const shouldShow = $derived(show ?? isLoading);

// Get phase label based on AI loading state
function getPhaseLabel(phase: AILoadingState['phase']): string {
  switch (phase) {
    case 'checking':
      return 'Checking AI capabilities...';
    case 'downloading':
      return 'Downloading AI models...';
    case 'initializing':
      return 'Initializing AI...';
    case 'ready':
      return 'AI Ready';
    case 'error':
      return 'Error loading AI';
    default:
      return 'Loading...';
  }
}

// Compute props for generic LoadingOverlay
const overlayMessage = $derived(message ?? getPhaseLabel(aiLoading.phase));
const overlayProgress = $derived(aiLoading.overallProgress);
const overlayItems = $derived(aiLoading.loaded);
const overlayError = $derived(aiLoading.error);
</script>

<LoadingOverlay
	show={shouldShow}
	message={overlayMessage}
	progress={overlayProgress}
	items={overlayItems}
	error={overlayError}
	dismissible={dismissible}
	class={className}
	ondismiss={ondismiss}
/>
