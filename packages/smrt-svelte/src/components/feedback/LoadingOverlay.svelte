<script lang="ts">
/**
 * Loading Overlay Component
 *
 * A generic full-screen loading overlay for any async operation.
 * Shows progress, completed items, and error states.
 */

interface LoadingOverlayProps {
  /** Whether to show the overlay */
  show?: boolean;
  /** Loading message to display */
  message?: string;
  /** Progress percentage (0-100) */
  progress?: number;
  /** List of completed items */
  items?: string[];
  /** Error object with message */
  error?: { message: string } | null;
  /** Allow dismissing the overlay */
  dismissible?: boolean;
  /** Custom CSS class */
  class?: string;
  /** Callback when dismissed */
  ondismiss?: () => void;
}

let {
  show = false,
  message = 'Loading...',
  progress = 0,
  items = [],
  error = null,
  dismissible = false,
  class: className = '',
  ondismiss,
}: LoadingOverlayProps = $props();

let dismissed = $state(false);

// Reset dismissed state when show becomes false
$effect(() => {
  if (!show) {
    dismissed = false;
  }
});

function handleDismiss() {
  if (dismissible) {
    dismissed = true;
    ondismiss?.();
  }
}
</script>

{#if show && !dismissed}
	<div
		class="loading-overlay {className}"
		role="dialog"
		aria-modal="true"
		aria-labelledby="loading-title"
	>
		<div class="overlay-backdrop"></div>

		<div class="overlay-content">
			<div class="loading-icon">
				{#if error}
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

			<h2 id="loading-title" class="title">
				{message}
			</h2>

			{#if progress > 0}
				<div class="progress-container">
					<div class="progress-bar">
						<div class="progress-fill" style:width="{progress}%"></div>
					</div>
					<span class="progress-text">{progress}%</span>
				</div>
			{/if}

			{#if items.length > 0}
				<div class="items-container">
					{#each items as item}
						<span class="item-badge">{item}</span>
					{/each}
				</div>
			{/if}

			{#if error}
				<p class="error-message">{error.message}</p>
			{/if}

			{#if dismissible}
				<button type="button" class="dismiss-btn" onclick={handleDismiss}>
					Continue
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.loading-overlay {
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
		margin: 0 0 16px;
	}

	.progress-container {
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

	.items-container {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: center;
		margin-top: 16px;
	}

	.item-badge {
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
