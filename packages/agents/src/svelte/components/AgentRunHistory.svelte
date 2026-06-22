<script lang="ts">
/**
 * AgentRunHistory - Display run history for an agent
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Badge } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { M } from '../i18n.js';
import type { AgentRunHistoryEntry } from '../types.js';
import {
  formatDuration,
  formatRelativeTime,
  getRunStatusVariant,
} from '../types.js';

const { t } = useI18n();

export interface Props {
  /** Run history entries */
  history: AgentRunHistoryEntry[];
  /** Loading state */
  loading?: boolean;
  /** Callback when entry is clicked */
  onEntryClick?: (entry: AgentRunHistoryEntry) => void;
  /** Empty state snippet */
  empty?: Snippet;
}

let { history = [], loading = false, onEntryClick, empty }: Props = $props();

function handleEntryClick(entry: AgentRunHistoryEntry) {
  onEntryClick?.(entry);
}
</script>

<div class="run-history-container">
  <table class="run-history" class:loading>
    <thead class="run-history__head">
      <tr>
        <th class="run-history__cell">Status</th>
        <th class="run-history__cell">Agent</th>
        <th class="run-history__cell">Started</th>
        <th class="run-history__cell">Duration</th>
        <th class="run-history__cell">Error</th>
      </tr>
    </thead>

    <tbody class="run-history__body">
      {#if loading}
        <tr class="run-history__row run-history__row--loading">
          <td class="run-history__cell run-history__cell--loading" colspan="5">
            <div class="run-history__loading">
              <span class="run-history__spinner"></span>
              <span>{t(M['agents.run_history.loading_history'])}</span>
            </div>
          </td>
        </tr>
      {:else if history.length === 0}
        <tr class="run-history__row run-history__row--empty">
          <td class="run-history__cell run-history__cell--empty" colspan="5">
            {#if empty}
              {@render empty()}
            {:else}
              <div class="run-history__empty">
                <span>{t(M['agents.run_history.no_run_history'])}</span>
              </div>
            {/if}
          </td>
        </tr>
      {:else}
        {#each history as entry (entry.id)}
          <tr
            class="run-history__row"
            onclick={() => handleEntryClick(entry)}
            role={onEntryClick ? 'button' : undefined}
            tabindex={onEntryClick ? 0 : undefined}
          >
            <td class="run-history__cell">
              <Badge variant={getRunStatusVariant(entry.status)} size="sm">
                {entry.status === 'success' ? 'Success' : 'Failed'}
              </Badge>
            </td>
            <td class="run-history__cell run-history__cell--agent">
              {entry.agentType}
            </td>
            <td class="run-history__cell run-history__cell--date">
              {formatRelativeTime(entry.startedAt)}
            </td>
            <td class="run-history__cell run-history__cell--duration">
              {formatDuration(entry.duration)}
            </td>
            <td class="run-history__cell run-history__cell--error">
              {#if entry.error}
                <span class="error-text" title={entry.error}>
                  {entry.error.length > 50 ? entry.error.slice(0, 50) + '...' : entry.error}
                </span>
              {:else}
                <span class="no-error">-</span>
              {/if}
            </td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<style>
  .run-history-container {
    width: 100%;
    overflow-x: auto;
  }

  .run-history {
    width: 100%;
    border-collapse: collapse;
    border-spacing: 0;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    background: var(--smrt-color-surface, #ffffff);
  }

  .run-history.loading {
    opacity: 0.7;
    pointer-events: none;
  }

  .run-history__head {
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  .run-history__head th {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-align: left;
    white-space: nowrap;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
  }

  .run-history__body tr {
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    transition: background-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .run-history__body tr:hover:not(.run-history__row--loading):not(.run-history__row--empty) {
    background: var(--smrt-color-surface-container-low, #f9fafb);
    cursor: pointer;
  }

  @media (prefers-reduced-motion: reduce) {
    .run-history__body tr {
      transition: none;
    }
    
    .run-history__spinner {
      animation: none;
    }
  }

  .run-history__cell {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
    vertical-align: middle;
  }

  .run-history__cell--agent {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .run-history__cell--date {
    color: var(--smrt-color-on-surface-variant, #43474e);
    white-space: nowrap;
  }

  .run-history__cell--duration {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    text-align: center;
  }

  .run-history__cell--error {
    max-width: 300px;
  }

  .error-text {
    color: var(--smrt-color-error, #ba1a1a);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    cursor: help;
  }

  .no-error {
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .run-history__cell--loading,
  .run-history__cell--empty {
    padding: var(--smrt-spacing-xl, 2rem);
    text-align: center;
  }

  .run-history__loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-sm, 0.5rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .run-history__spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-top-color: var(--smrt-color-primary, #005ac1);
    border-radius: var(--smrt-radius-full, 9999px);
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .run-history__empty {
    color: var(--smrt-color-on-surface-variant, #43474e);
  }
</style>
