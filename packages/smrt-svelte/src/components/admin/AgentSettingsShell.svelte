<script lang="ts">
import type {
  AgentUIComponentRegistry,
  AgentUISlots,
} from '@happyvertical/smrt-agents/ui';
import AgentAdminTabs from './AgentAdminTabs.svelte';

/**
 * Serialized agent data passed from server
 * (Agent instances can't be passed directly to client)
 */
interface AgentData {
  id: string;
  name?: string;
  /** Agent class name (e.g., 'Praeco') - determined from _meta_type or explicit */
  agentClass: string;
  /** UI slots for this agent */
  slots: AgentUISlots;
}

interface Props {
  /** The registry to look up components from */
  registry: AgentUIComponentRegistry;
  /** List of agents to display (serialized data, not instances) */
  agents: AgentData[];
  /** Config data for each agent and slot: agentId -> slotId -> config */
  configs: Record<string, Record<string, unknown>>;
  /** Callback when a config is saved */
  onSave?: (agentId: string, slotId: string, config: unknown) => Promise<void>;
  /** Whether all panels are read-only */
  readonly?: boolean;
  /** File configs: agentId -> slotId -> config */
  fileConfigs?: Record<string, Record<string, unknown>>;
  /** Database configs: agentId -> slotId -> config */
  dbConfigs?: Record<string, Record<string, unknown>>;
}

const {
  registry,
  agents,
  configs,
  onSave,
  readonly = false,
  fileConfigs = {},
  dbConfigs = {},
}: Props = $props();

let activeAgentId = $state<string | null>(null);

// Initialize to first agent
$effect(() => {
  if (activeAgentId === null && agents.length > 0) {
    activeAgentId = agents[0].id;
  }
});

const activeAgent = $derived(agents.find((a) => a.id === activeAgentId));

function handleAgentClick(agentId: string) {
  activeAgentId = agentId;
}

async function handleSave(slotId: string, config: unknown) {
  if (activeAgentId && onSave) {
    await onSave(activeAgentId, slotId, config);
  }
}
</script>

<div class="agent-settings-shell" class:single-agent={agents.length === 1}>
	{#if agents.length > 1}
		<aside class="agents-sidebar">
			<h3 class="sidebar-title">Agents</h3>
			<nav class="agents-list">
				{#each agents as agent}
					<button
						class="agent-button"
						class:active={activeAgentId === agent.id}
						onclick={() => handleAgentClick(agent.id)}
					>
						<span class="agent-class">{agent.agentClass}</span>
						{#if agent.name}
							<span class="agent-name">{agent.name}</span>
						{/if}
					</button>
				{/each}
			</nav>
		</aside>
	{/if}

	<main class="agent-content">
		{#if activeAgent}
			<header class="agent-header">
				<h2 class="agent-title">{activeAgent.agentClass}</h2>
				{#if activeAgent.name}
					<p class="agent-subtitle">{activeAgent.name}</p>
				{/if}
			</header>

			<AgentAdminTabs
				{registry}
				agentClass={activeAgent.agentClass}
				slots={activeAgent.slots}
				configs={configs[activeAgent.id] ?? {}}
				onSave={handleSave}
				{readonly}
				fileConfigs={fileConfigs[activeAgent.id]}
				dbConfigs={dbConfigs[activeAgent.id]}
			/>
		{:else if agents.length === 0}
			<div class="no-agents">
				<div class="no-agents-icon">🤖</div>
				<p class="no-agents-message">No agents configured for this site.</p>
				<p class="no-agents-hint">
					Agents are discovered by matching their context field to the site
					domain.
				</p>
			</div>
		{/if}
	</main>
</div>

<style>
	.agent-settings-shell {
		display: grid;
		grid-template-columns: 220px 1fr;
		gap: 1.5rem;
		min-height: 400px;
	}

	.agent-settings-shell.single-agent {
		grid-template-columns: 1fr;
	}

	.agents-sidebar {
		background: #f8fafc;
		border-radius: 8px;
		padding: 1rem;
		border: 1px solid #e2e8f0;
	}

	.sidebar-title {
		margin: 0 0 0.75rem 0;
		padding: 0 0.5rem 0.75rem;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #64748b;
		border-bottom: 1px solid #e2e8f0;
	}

	.agents-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.agent-button {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.125rem;
		padding: 0.625rem 0.75rem;
		border: none;
		background: transparent;
		border-radius: 6px;
		cursor: pointer;
		text-align: left;
		width: 100%;
		transition:
			background-color 0.15s,
			color 0.15s;
	}

	.agent-button:hover {
		background: #e2e8f0;
	}

	.agent-button.active {
		background: #3b82f6;
	}

	.agent-button.active .agent-class,
	.agent-button.active .agent-name {
		color: white;
	}

	.agent-class {
		font-size: 0.875rem;
		font-weight: 600;
		color: #1e293b;
	}

	.agent-name {
		font-size: 0.75rem;
		color: #64748b;
	}

	.agent-content {
		min-width: 0;
	}

	.agent-header {
		margin-bottom: 1.5rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid #e2e8f0;
	}

	.agent-title {
		margin: 0;
		font-size: 1.5rem;
		font-weight: 600;
		color: #1e293b;
	}

	.agent-subtitle {
		margin: 0.25rem 0 0;
		font-size: 0.9375rem;
		color: #64748b;
	}

	.no-agents {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 4rem 2rem;
		text-align: center;
		background: #f8fafc;
		border: 1px dashed #e2e8f0;
		border-radius: 8px;
		min-height: 300px;
	}

	.no-agents-icon {
		font-size: 3rem;
		margin-bottom: 1rem;
		opacity: 0.5;
	}

	.no-agents-message {
		margin: 0 0 0.5rem 0;
		font-size: 1rem;
		color: #64748b;
	}

	.no-agents-hint {
		margin: 0;
		font-size: 0.875rem;
		color: #94a3b8;
		max-width: 400px;
	}
</style>
