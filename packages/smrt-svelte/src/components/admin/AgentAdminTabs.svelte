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

async function handleSave(config: unknown) {
  if (activeSlotId && onSave) {
    await onSave(activeSlotId, config);
  }
}
</script>

<div class="agent-admin-tabs">
	<div class="tabs-nav" role="tablist">
		{#each sortedSlots as [slotId, slot]}
			<button
				class="tab-button"
				class:active={activeSlotId === slotId}
				role="tab"
				aria-selected={activeSlotId === slotId}
				aria-controls="panel-{slotId}"
				onclick={() => handleSlotClick(slotId)}
			>
				{#if slot.icon}
					<span class="tab-icon">{slot.icon}</span>
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
		border-bottom: 1px solid #e2e8f0;
		padding-bottom: 0;
	}

	.tab-button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border: none;
		background: transparent;
		color: #64748b;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		transition:
			color 0.15s,
			border-color 0.15s;
	}

	.tab-button:hover {
		color: #334155;
	}

	.tab-button.active {
		color: #3b82f6;
		border-bottom-color: #3b82f6;
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
		background: #f0f9ff;
		border-left: 3px solid #3b82f6;
		border-radius: 0 6px 6px 0;
		font-size: 0.875rem;
		color: #1e40af;
	}

	.no-slots {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 200px;
		color: #64748b;
		font-size: 0.9375rem;
	}

	.no-slots p {
		margin: 0;
	}
</style>
