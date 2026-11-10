<script lang="ts">
/**
 * Loading Overlay Component
 *
 * A generic full-screen loading overlay for any async operation.
 * Shows progress, completed items, and error states.
 */

/** Props for LoadingOverlay component */
export interface Props {
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
}: Props = $props();

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

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && dismissible) {
    e.preventDefault();
    handleDismiss();
  }
}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if show && !dismissed}
	<div
		class="smrt-loading-overlay__root {className}"
		role="dialog"
		aria-modal="true"
		aria-labelledby="loading-title"
		aria-describedby={items.length > 0 ? 'loading-items' : undefined}
		aria-busy={!error} data-smrt-component="LoadingOverlay"
	>
		<div class="smrt-loading-overlay__backdrop" data-smrt-part="backdrop"></div>

		<div class="smrt-loading-overlay__content" data-smrt-part="panel">
			<div class="smrt-loading-overlay__icon" data-smrt-part="icon">
				{#if error}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="smrt-loading-overlay__glyph smrt-loading-overlay__glyph--error">
						<circle cx="12" cy="12" r="10" stroke-width="2" />
						<path d="M12 8v4m0 4h.01" stroke-width="2" stroke-linecap="round" />
					</svg>
				{:else}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" class="smrt-loading-overlay__glyph smrt-loading-overlay__glyph--spinner">
						<path
							d="M12 2a10 10 0 0 1 10 10"
							stroke-width="2"
							stroke-linecap="round"
						/>
					</svg>
				{/if}
			</div>

			<h2 id="loading-title" class="smrt-loading-overlay__title" data-smrt-part="title">
				{message}
			</h2>

			{#if progress > 0}
				<div class="smrt-loading-overlay__progress" data-smrt-part="progress">
					<div class="smrt-loading-overlay__track" data-smrt-part="track">
						<div class="smrt-loading-overlay__indicator" data-smrt-part="indicator" style:width="{progress}%"></div>
					</div>
					<span class="smrt-loading-overlay__value" data-smrt-part="value">{progress}%</span>
				</div>
			{/if}

			{#if items.length > 0}
				<div class="smrt-loading-overlay__items" data-smrt-part="items" id="loading-items">
					{#each items as item}
						<span class="smrt-loading-overlay__item" data-smrt-part="item">{item}</span>
					{/each}
				</div>
			{/if}

			{#if error}
				<!-- role="alert" (assertive live region) so the failure is announced
				     to screen readers when it appears (#1586). aria-busy flips to
				     false on error, so without this the overlay changed visually only. -->
				<p class="smrt-loading-overlay__error" data-smrt-part="error" role="alert" aria-live="assertive">
					{error.message}
				</p>
			{/if}

			{#if dismissible}
				<button type="button" class="smrt-loading-overlay__dismiss" data-smrt-part="close" onclick={handleDismiss}>
					Continue
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-loading-overlay__root {
    position: fixed;
    inset: 0;
    z-index: var(--smrt-z-index-loading, 1700);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .smrt-loading-overlay__backdrop {
    position: absolute;
    inset: 0;
  }
  .smrt-loading-overlay__content {
    position: relative;
    padding: var(--smrt-spacing-8) var(--smrt-spacing-10);
    max-width: 400px;
    width: 90%;
  }
  .smrt-loading-overlay__icon {
    width: 48px;
    height: 48px;
    margin: 0 auto var(--smrt-spacing-4);
  }
  .smrt-loading-overlay__glyph {
    width: 100%;
    height: 100%;
  }
  .smrt-loading-overlay__title {
    margin: 0 0 var(--smrt-spacing-4);
  }
  .smrt-loading-overlay__progress {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3);
    margin: var(--smrt-spacing-4) 0;
  }
  .smrt-loading-overlay__track {
    flex: 1;
    height: 8px;
    overflow: hidden;
  }
  .smrt-loading-overlay__indicator {
    height: 100%;
  }
  .smrt-loading-overlay__value {
    min-width: 40px;
  }
  .smrt-loading-overlay__items {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
    justify-content: center;
    margin-top: var(--smrt-spacing-4);
  }
  .smrt-loading-overlay__item {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
  }
  .smrt-loading-overlay__error {
    margin: var(--smrt-spacing-4) 0 0;
    padding: var(--smrt-spacing-3);
  }
  .smrt-loading-overlay__dismiss {
    margin-top: var(--smrt-spacing-5);
    padding: var(--smrt-spacing-3) var(--smrt-spacing-5);
    cursor: pointer;
  }
}

@layer smrt.theme {
  .smrt-loading-overlay__backdrop {
    background: var(--smrt-color-scrim, rgba(0, 0, 0, 0.5));
    backdrop-filter: blur(4px);
  }
  .smrt-loading-overlay__content {
    background: var(--smrt-color-surface-container-high, white);
    border-radius: var(--smrt-radius-xl);
    text-align: center;
    box-shadow: var(--smrt-elevation-5, 0 25px 50px -12px rgba(0, 0, 0, 0.25));
  }
  .smrt-loading-overlay__glyph.smrt-loading-overlay__glyph--spinner {
    color: var(--smrt-color-primary);
    animation: spin 1s linear infinite;
  }
  .smrt-loading-overlay__glyph.smrt-loading-overlay__glyph--error {
    color: var(--smrt-color-error);
  }
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
  .smrt-loading-overlay__title {
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
  }
  .smrt-loading-overlay__track {
    background: var(--smrt-color-surface-container-highest);
    border-radius: var(--smrt-radius-sm);
  }
  .smrt-loading-overlay__indicator {
    background: linear-gradient(
			90deg,
			var(--smrt-color-primary),
			color-mix(in srgb, var(--smrt-color-primary) 70%, white)
		);
    border-radius: var(--smrt-radius-sm);
    transition: width var(--smrt-duration-short4, 300ms) var(--smrt-easing-standard, ease);
  }
  .smrt-loading-overlay__value {
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-primary);
  }
  .smrt-loading-overlay__item {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-loading-overlay__error {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-error);
    background: var(--smrt-color-error-container);
    border-radius: var(--smrt-radius-md);
  }
  .smrt-loading-overlay__dismiss {
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
    background: transparent;
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-md);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-loading-overlay__dismiss:hover {
    background: var(--smrt-color-surface-container-highest);
    border-color: var(--smrt-hairline-strong-color);
  }
  .smrt-loading-overlay__dismiss:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-loading-overlay__glyph.smrt-loading-overlay__glyph--spinner {
      animation: none;
    }
    .smrt-loading-overlay__indicator {
      transition: none;
    }
  }
}

</style>
