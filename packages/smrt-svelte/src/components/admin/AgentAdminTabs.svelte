<script lang="ts">
import type {
  AgentUIComponentRegistry,
  AgentUISlots,
} from '@happyvertical/smrt-agents/ui';
import AgentAdminPanel from './AgentAdminPanel.svelte';

interface Props {
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
  const enabledSlots = sortedSlots.filter(([, slot]) => !slot.disabled);
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
      const tabButton = document.querySelector(
        `[data-tab-id="${nextSlotId}"]`,
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
	<div class="tabs-nav" role="tablist" aria-label="Agent configuration tabs">
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
				disabled={slot.disabled}
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
		border-bottom: 1px solid var(--md-sys-color-outline-variant, #e2e8f0);
		padding-bottom: 0;
	}

	.tab-button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border: none;
		background: transparent;
		color: var(--md-sys-color-on-surface-variant, #64748b);
		font-size: var(--md-sys-typescale-label-large-size, 0.875rem);
		font-weight: 500;
		cursor: pointer;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		transition:
			color 0.15s,
			border-color 0.15s;
	}

	.tab-button:hover:not(:disabled) {
		color: var(--md-sys-color-on-surface, #334155);
	}

	.tab-button.active {
		color: var(--md-sys-color-primary, #3b82f6);
		border-bottom-color: var(--md-sys-color-primary, #3b82f6);
	}

	.tab-button:disabled {
		opacity: 0.38;
		cursor: not-allowed;
	}

	.tab-button:focus-visible {
		outline: 2px solid var(--md-sys-color-primary, #3b82f6);
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
		animation: fadeIn 0.15s ease-out;
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

	.slot-description {
		margin: 0 0 1rem 0;
		padding: 0.75rem 1rem;
		background: var(--md-sys-color-primary-container, #f0f9ff);
		border-left: 3px solid var(--md-sys-color-primary, #3b82f6);
		border-radius: 0 6px 6px 0;
		font-size: var(--md-sys-typescale-body-medium-size, 0.875rem);
		color: var(--md-sys-color-on-primary-container, #1e40af);
	}

	.no-slots {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 200px;
		color: var(--md-sys-color-on-surface-variant, #64748b);
		font-size: var(--md-sys-typescale-body-medium-size, 0.9375rem);
	}

	.no-slots p {
		margin: 0;
	}
</style>
