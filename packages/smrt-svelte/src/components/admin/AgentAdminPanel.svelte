<script lang="ts">
import type {
  AdminPanelBaseProps,
  AgentUIComponentRegistry,
  AgentUISlot,
} from '@happyvertical/smrt-agents/ui';

interface Props {
  /** The registry to look up components from */
  registry: AgentUIComponentRegistry;
  /** The agent class name (e.g., 'Praeco') */
  agentClass: string;
  /** The slot ID to render */
  slotId: string;
  /** The slot definition */
  slot: AgentUISlot;
  /** The current configuration for this slot */
  config: unknown;
  /** Callback when config is saved */
  onSave?: (config: unknown) => Promise<void>;
  /** Whether the panel is read-only */
  readonly?: boolean;
  /** File-based config defaults */
  fileConfig?: unknown;
  /** Database-persisted config overrides */
  dbConfig?: unknown;
}

const {
  registry,
  agentClass,
  slotId,
  slot,
  config,
  onSave,
  readonly = false,
  fileConfig,
  dbConfig,
}: Props = $props();

const Component = $derived(registry.get(agentClass, slotId));

async function handleSave(newConfig: unknown) {
  await onSave?.(newConfig);
}
</script>

{#if Component}
	<Component
		{config}
		onSave={handleSave}
		{readonly}
		{fileConfig}
		{dbConfig}
	/>
{:else}
	<div class="no-panel">
		<div class="no-panel-icon">⚙️</div>
		<p class="no-panel-message">
			No admin panel registered for <code>{agentClass}.{slotId}</code>
		</p>
		<p class="no-panel-hint">
			Import the agent's admin package to register its panels.
		</p>
	</div>
{/if}

<style>
	.no-panel {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 3rem 2rem;
		text-align: center;
		background: #f8fafc;
		border: 1px dashed #e2e8f0;
		border-radius: 8px;
		min-height: 200px;
	}

	.no-panel-icon {
		font-size: 2.5rem;
		margin-bottom: 1rem;
		opacity: 0.5;
	}

	.no-panel-message {
		margin: 0 0 0.5rem 0;
		font-size: 0.9375rem;
		color: #64748b;
	}

	.no-panel-message code {
		background: #e2e8f0;
		padding: 0.125rem 0.375rem;
		border-radius: 4px;
		font-family: 'SF Mono', Monaco, Consolas, monospace;
		font-size: 0.875rem;
	}

	.no-panel-hint {
		margin: 0;
		font-size: 0.8125rem;
		color: #94a3b8;
	}
</style>
