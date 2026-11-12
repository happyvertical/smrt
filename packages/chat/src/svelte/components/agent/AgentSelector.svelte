<script lang="ts">
/**
 * AgentSelector - Agent picker UI
 * Grid/list of available agents with avatars, names, and descriptions.
 * Disabled state for unavailable agents.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n.js';
import type { AgentDescriptor } from '../../types.js';
import Avatar from '../shared/Avatar.svelte';

export interface Props {
  /** Available agents */
  agents: AgentDescriptor[];
  /** Select an agent */
  onselect: (agentId: string) => void;
}

const { agents, onselect }: Props = $props();

const { t } = useI18n();
</script>

<div class="smrt-agent-selector__root" aria-label={t(M['chat.agent_selector.select_an_agent'])} data-smrt-component="AgentSelector">
  <h3 class="smrt-agent-selector__title" data-smrt-part="title">{t(M['chat.agent_selector.title'])}</h3>

  <div class="smrt-agent-selector__grid" data-smrt-part="list" role="listbox" aria-label={t(M['chat.agent_selector.available_agents'])}>
    {#each agents as agent (agent.id)}
      <!-- raw-primitive-allow: large pressable selection card with role=option wrapping rich content (avatar, name, description, unavailable badge) inside a role=listbox; no Button primitive owns this structural listbox-option pattern -->
      <button
        class="smrt-agent-selector__card"
        data-smrt-part="option"
        type="button"
        role="option"
        aria-selected={false}
        aria-disabled={!agent.isAvailable}
        disabled={!agent.isAvailable}
        onclick={() => onselect(agent.id)}
  class:smrt-agent-selector__card--unavailable={!agent.isAvailable}

      >
        <Avatar
          name={agent.name}
          avatarUrl={agent.avatarUrl}
          size="lg"
        />

        <div class="smrt-agent-selector__card-body" data-smrt-part="body">
          <span class="smrt-agent-selector__card-name" data-smrt-part="label">{agent.name}</span>
          <span class="smrt-agent-selector__card-desc" data-smrt-part="meta">{agent.description}</span>
        </div>

        {#if !agent.isAvailable}
          <span class="smrt-agent-selector__unavailable-badge" data-smrt-part="badge">Unavailable</span>
        {/if}
      </button>
    {/each}
  </div>

  {#if agents.length === 0}
    <div class="smrt-agent-selector__empty" data-smrt-part="empty">
      <span class="smrt-agent-selector__empty-text" data-smrt-part="message">{t(M['chat.agent_selector.empty'])}</span>
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-agent-selector__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4);
    padding: var(--smrt-spacing-4);
  }
  .smrt-agent-selector__title {
    margin: 0;
  }
  .smrt-agent-selector__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: var(--smrt-spacing-3);
  }
  .smrt-agent-selector__card {
    display: flex;
    align-items: flex-start;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-4);
    cursor: pointer;
    position: relative;
  }
  .smrt-agent-selector__card--unavailable {
    cursor: not-allowed;
  }
  .smrt-agent-selector__card-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
    min-width: 0;
  }
  .smrt-agent-selector__card-desc {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .smrt-agent-selector__unavailable-badge {
    position: absolute;
    top: 8px;
    right: 8px;
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  .smrt-agent-selector__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--smrt-spacing-10);
  }
  @media (max-width: 480px) {
    .smrt-agent-selector__grid {
      grid-template-columns: 1fr;
    }
  }
}

@layer smrt.theme {
  .smrt-agent-selector__title {
    font: var(--smrt-typography-title-medium-font, 600 1rem/1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-agent-selector__card {
    background: var(--smrt-color-surface-container-low);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-large);
    text-align: left;
    color: var(--smrt-color-on-surface);
    transition:
      background var(--smrt-duration-short2, 150ms),
      box-shadow var(--smrt-duration-short2, 150ms),
      border-color var(--smrt-duration-short2, 150ms);
  }
  .smrt-agent-selector__card:hover:not(:disabled) {
    background: var(--smrt-color-surface-container);
    border-color: var(--smrt-color-primary);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px rgba(0, 0, 0, 0.1));
  }
  .smrt-agent-selector__card:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }
  .smrt-agent-selector__card--unavailable {
    opacity: 0.55;
  }
  .smrt-agent-selector__card-name {
    font: var(--smrt-typography-title-small-font, 600 0.875rem/1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-agent-selector__card-desc {
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-selector__unavailable-badge {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-outline);
    background: var(--smrt-color-surface-variant);
    border-radius: var(--smrt-radius-full);
  }
  .smrt-agent-selector__empty-text {
    font: var(--smrt-typography-body-medium-font, 0.875rem/1.4 sans-serif);
    color: var(--smrt-color-outline);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-agent-selector__card {
      transition: none;
    }
  }
}

</style>
