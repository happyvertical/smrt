<script lang="ts">
/**
 * AgentSelector - Agent picker UI
 * Grid/list of available agents with avatars, names, and descriptions.
 * Disabled state for unavailable agents.
 */
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
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

<div class="agent-selector" aria-label={t(M['chat.agent_selector.select_an_agent'])}>
  <h3 class="agent-selector__title">{t(M['chat.agent_selector.title'])}</h3>

  <div class="agent-selector__grid" role="listbox" aria-label={t(M['chat.agent_selector.available_agents'])}>
    {#each agents as agent (agent.id)}
      <button
        class="agent-selector__card"
        class:agent-selector__card--unavailable={!agent.isAvailable}
        type="button"
        role="option"
        aria-selected={false}
        aria-disabled={!agent.isAvailable}
        disabled={!agent.isAvailable}
        onclick={() => onselect(agent.id)}
      >
        <Avatar
          name={agent.name}
          avatarUrl={agent.avatarUrl}
          size="lg"
        />

        <div class="agent-selector__card-body">
          <span class="agent-selector__card-name">{agent.name}</span>
          <span class="agent-selector__card-desc">{agent.description}</span>
        </div>

        {#if !agent.isAvailable}
          <span class="agent-selector__unavailable-badge">Unavailable</span>
        {/if}
      </button>
    {/each}
  </div>

  {#if agents.length === 0}
    <div class="agent-selector__empty">
      <span class="agent-selector__empty-text">{t(M['chat.agent_selector.empty'])}</span>
    </div>
  {/if}
</div>

<style>
  .agent-selector {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 16px);
    padding: var(--smrt-spacing-4, 16px);
  }

  .agent-selector__title {
    font: var(--smrt-typography-title-medium-font, 600 1rem/1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    margin: 0;
  }

  .agent-selector__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: var(--smrt-spacing-3, 12px);
  }

  .agent-selector__card {
    display: flex;
    align-items: flex-start;
    gap: var(--smrt-spacing-3, 12px);
    padding: var(--smrt-spacing-4, 16px);
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-large, 12px);
    cursor: pointer;
    text-align: left;
    color: var(--smrt-color-on-surface, #1a1c1e);
    position: relative;
    transition:
      background var(--smrt-duration-short2, 150ms),
      box-shadow var(--smrt-duration-short2, 150ms),
      border-color var(--smrt-duration-short2, 150ms);
  }

  .agent-selector__card:hover:not(:disabled) {
    background: var(--smrt-color-surface-container, #f0f0f4);
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px rgba(0, 0, 0, 0.1));
  }

  .agent-selector__card:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .agent-selector__card--unavailable {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .agent-selector__card-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    min-width: 0;
  }

  .agent-selector__card-name {
    font: var(--smrt-typography-title-small-font, 600 0.875rem/1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .agent-selector__card-desc {
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .agent-selector__unavailable-badge {
    position: absolute;
    top: 8px;
    right: 8px;
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-outline, #74777f);
    background: var(--smrt-color-surface-variant, #e1e2ec);
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .agent-selector__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--smrt-spacing-10, 40px);
  }

  .agent-selector__empty-text {
    font: var(--smrt-typography-body-medium-font, 0.875rem/1.4 sans-serif);
    color: var(--smrt-color-outline, #74777f);
  }

  @media (max-width: 480px) {
    .agent-selector__grid {
      grid-template-columns: 1fr;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .agent-selector__card {
      transition: none;
    }
  }
</style>
