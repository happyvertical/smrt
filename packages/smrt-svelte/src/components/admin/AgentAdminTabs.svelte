<script lang="ts">
import type {
  AgentUIComponentRegistry,
  AgentUISlots,
} from '@happyvertical/smrt-agents/ui';
import AgentAdminPanel from './AgentAdminPanel.svelte';

export interface Props {
  /** The registry to look up components from */
  registry: AgentUIComponentRegistry;
  /** The agent class name (e.g., 'Praeco') */
  agentClass: string;
  /** UI slots declared by the agent */
  slots: AgentUISlots;
  /** Config data for each slot (keyed by slotId) */
  configs: Record<string, unknown>;
  /** Callback when a slot config is saved */
  onSave?: (slotId: string, config: unknown) => Promise<void>;
  /** Whether all panels are read-only */
  readonly?: boolean;
  /** File-based configs for each slot */
  fileConfigs?: Record<string, unknown>;
  /** Database configs for each slot */
  dbConfigs?: Record<string, unknown>;
}

const {
  registry,
  agentClass,
  slots,
  configs,
  onSave,
  readonly = false,
  fileConfigs = {},
  dbConfigs = {},
}: Props = $props();

// Sort slots by order, then by label
const sortedSlots = $derived(
  Object.entries(slots).sort(([, a], [, b]) => {
    const orderA = a.order ?? 99;
    const orderB = b.order ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    return a.label.localeCompare(b.label);
  }),
);

let activeSlotId = $state<string | null>(null);
let tablistEl: HTMLElement | null = $state(null);

// Initialize active slot to first sorted slot
$effect(() => {
  if (activeSlotId === null && sortedSlots.length > 0) {
    activeSlotId = sortedSlots[0][0];
  }
});

function handleSlotClick(slotId: string) {
  activeSlotId = slotId;
}

/**
 * Handle keyboard navigation for accessibility
 */
function handleKeydown(event: KeyboardEvent, currentSlotId: string) {
  const enabledSlots = sortedSlots;
  const currentIndex = enabledSlots.findIndex(([id]) => id === currentSlotId);

  if (currentIndex === -1) return;

  let nextIndex: number | null = null;

  switch (event.key) {
    case 'ArrowRight':
      event.preventDefault();
      nextIndex = (currentIndex + 1) % enabledSlots.length;
      break;
    case 'ArrowLeft':
      event.preventDefault();
      nextIndex =
        (currentIndex - 1 + enabledSlots.length) % enabledSlots.length;
      break;
    case 'Home':
      event.preventDefault();
      nextIndex = 0;
      break;
    case 'End':
      event.preventDefault();
      nextIndex = enabledSlots.length - 1;
      break;
  }

  if (nextIndex !== null && nextIndex !== currentIndex) {
    const [nextSlotId] = enabledSlots[nextIndex];
    activeSlotId = nextSlotId;
    // Focus the next tab after DOM update
    requestAnimationFrame(() => {
      const tabButton = tablistEl?.querySelector(
        `[data-tab-id="${CSS.escape(nextSlotId)}"]`,
      ) as HTMLElement;
      tabButton?.focus();
    });
  }
}

async function handleSave(config: unknown) {
  if (activeSlotId && onSave) {
    await onSave(activeSlotId, config);
  }
}
</script>

<div class="agent-admin-tabs">
	<div class="tabs-nav" role="tablist" aria-label="Agent configuration tabs" bind:this={tablistEl}>
		{#each sortedSlots as [slotId, slot]}
			<button
				class="tab-button"
				class:active={activeSlotId === slotId}
				role="tab"
				aria-selected={activeSlotId === slotId}
				aria-controls="panel-{slotId}"
				id="tab-{slotId}"
				data-tab-id={slotId}
				tabindex={activeSlotId === slotId ? 0 : -1}
				onclick={() => handleSlotClick(slotId)}
				onkeydown={(e) => handleKeydown(e, slotId)}
			>
				{#if slot.icon}
					<span class="tab-icon" aria-hidden="true">{slot.icon}</span>
				{/if}
				<span class="tab-label">{slot.label}</span>
			</button>
		{/each}
	</div>

	<div class="tab-content">
		{#if activeSlotId && slots[activeSlotId]}
			{@const activeSlot = slots[activeSlotId]}
			<div
				id="panel-{activeSlotId}"
				class="tab-panel"
				role="tabpanel"
				aria-labelledby="tab-{activeSlotId}"
			>
				{#if activeSlot.description}
					<p class="slot-description">{activeSlot.description}</p>
				{/if}

				<AgentAdminPanel
					{registry}
					{agentClass}
					slotId={activeSlotId}
					slot={activeSlot}
					config={configs[activeSlotId] ?? {}}
					onSave={handleSave}
					{readonly}
					fileConfig={fileConfigs[activeSlotId]}
					dbConfig={dbConfigs[activeSlotId]}
				/>
			</div>
		{:else}
			<div class="no-slots">
				<p>No configuration slots available for this agent.</p>
			</div>
		{/if}
	</div>
</div>

<style>
	.agent-admin-tabs {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.tabs-nav {
		display: flex;
		gap: 0.25rem;
		border-bottom: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
		padding-bottom: 0;
	}

	.tab-button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border: none;
		background: transparent;
		color: var(--smrt-color-on-surface-variant, #64748b);
		font-size: var(--smrt-typography-label-large-size, 0.875rem);
		font-weight: 500;
		cursor: pointer;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		transition:
			color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease),
			border-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
	}

	.tab-button:hover:not(:disabled) {
		color: var(--smrt-color-on-surface, #334155);
	}

	.tab-button.active {
		color: var(--smrt-color-primary, #3b82f6);
		border-bottom-color: var(--smrt-color-primary, #3b82f6);
	}

	.tab-button:disabled {
		opacity: 0.38;
		cursor: not-allowed;
	}

	.tab-button:focus-visible {
		outline: 2px solid var(--smrt-color-primary, #3b82f6);
		outline-offset: 2px;
	}

	.tab-icon {
		font-size: 1rem;
		opacity: 0.8;
	}

	.tab-label {
		white-space: nowrap;
	}

	.tab-content {
		min-height: 300px;
	}

	.tab-panel {
		animation: fadeIn var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease-out);
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.tab-panel {
			animation: none;
		}
	}

	.slot-description {
		margin: 0 0 1rem 0;
		padding: 0.75rem 1rem;
		background: var(--smrt-color-primary-container, #f0f9ff);
		border-left: 3px solid var(--smrt-color-primary, #3b82f6);
		border-radius: 0 var(--smrt-radius-md, 8px) var(--smrt-radius-md, 8px) 0;
		font-size: var(--smrt-typography-body-medium-size, 0.875rem);
		color: var(--smrt-color-on-primary-container, #1e40af);
	}

	.no-slots {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 200px;
		color: var(--smrt-color-on-surface-variant, #64748b);
		font-size: var(--smrt-typography-body-medium-size, 0.9375rem);
	}

	.no-slots p {
		margin: 0;
	}
</style>
