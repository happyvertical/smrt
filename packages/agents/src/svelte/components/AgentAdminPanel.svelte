<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type {
  AdminPanelBaseProps,
  AgentUIComponentRegistry,
  AgentUISlot,
} from '../../ui.js';
import { M } from '../i18n.js';
import AgentSettingsForm from './AgentSettingsForm.svelte';

const { t } = useI18n();

export interface Props {
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
		readonly={readonly || !onSave}
		{fileConfig}
		{dbConfig}
	/>
{:else if slot.settingsSchema}
	<AgentSettingsForm
		config={(config ?? {}) as Record<string, unknown>}
		schema={slot.settingsSchema}
		onSave={handleSave}
		readonly={readonly || !onSave}
	/>
{:else}
	<div class="smrt-agent-admin-panel__root" data-smrt-component="AgentAdminPanel">
		<div class="smrt-agent-admin-panel__icon" data-smrt-part="icon">⚙️</div>
		<p class="smrt-agent-admin-panel__message" data-smrt-part="message">
			{t(M['ui.agent_admin_panel.no_panel_message'])} <code>{agentClass}.{slotId}</code>
		</p>
		<p class="smrt-agent-admin-panel__hint" data-smrt-part="hint">
			{t(M['ui.agent_admin_panel.no_panel_hint'])}
		</p>
	</div>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-agent-admin-panel__root {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 3rem 2rem;
    min-height: 200px;
  }
  .smrt-agent-admin-panel__icon {
    margin-bottom: 1rem;
  }
  .smrt-agent-admin-panel__message {
    margin: 0 0 0.5rem 0;
  }
  .smrt-agent-admin-panel__message code {
    padding: var(--smrt-spacing-1, 0.125rem) var(--smrt-spacing-2, 0.375rem);
  }
  .smrt-agent-admin-panel__hint {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-agent-admin-panel__root {
    text-align: center;
    background: var(--smrt-color-surface-container-low);
    border: 1px dashed var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-medium);
  }
  .smrt-agent-admin-panel__icon {
    font-size: var(--smrt-typography-display-medium-size, 2.5rem);
    opacity: 0.5;
  }
  .smrt-agent-admin-panel__message {
    font-size: var(--smrt-typography-body-large-size, 0.9375rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-admin-panel__message code {
    background: var(--smrt-color-surface-container-high);
    border-radius: var(--smrt-radius-small);
    font-family: var(--smrt-font-family-mono, 'SF Mono', Monaco, Consolas, monospace);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-agent-admin-panel__hint {
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
