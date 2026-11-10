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

function handleEntryKeydown(entry: AgentRunHistoryEntry, event: KeyboardEvent) {
  if (!onEntryClick) return;
  if (event.key === 'Enter' || event.key === ' ') {
    // Prevent Space from scrolling the page when activating the row.
    event.preventDefault();
    onEntryClick(entry);
  }
}
</script>

<div class="smrt-agent-run-history__root" data-smrt-component="AgentRunHistory">
  <table class="smrt-agent-run-history__table" data-smrt-part="table" class:smrt-agent-run-history__loading={loading}>
    <thead class="smrt-agent-run-history__head" data-smrt-part="header">
      <tr>
        <th class="smrt-agent-run-history__cell" data-smrt-part="cell">Status</th>
        <th class="smrt-agent-run-history__cell" data-smrt-part="cell">Agent</th>
        <th class="smrt-agent-run-history__cell" data-smrt-part="cell">Started</th>
        <th class="smrt-agent-run-history__cell" data-smrt-part="cell">Duration</th>
        <th class="smrt-agent-run-history__cell" data-smrt-part="cell">Error</th>
      </tr>
    </thead>

    <tbody class="smrt-agent-run-history__body" data-smrt-part="body">
      {#if loading}
        <tr class="smrt-agent-run-history__row smrt-agent-run-history__row-loading" data-smrt-part="row">
          <td class="smrt-agent-run-history__cell smrt-agent-run-history__cell-loading" data-smrt-part="cell" colspan="5">
            <div class="smrt-agent-run-history__progress" data-smrt-part="progress">
              <span class="smrt-agent-run-history__spinner" data-smrt-part="spinner"></span>
              <span>{t(M['agents.run_history.loading_history'])}</span>
            </div>
          </td>
        </tr>
      {:else if history.length === 0}
        <tr class="smrt-agent-run-history__row smrt-agent-run-history__row-empty" data-smrt-part="row">
          <td class="smrt-agent-run-history__cell smrt-agent-run-history__cell-empty" data-smrt-part="cell" colspan="5">
            {#if empty}
              {@render empty()}
            {:else}
              <div class="smrt-agent-run-history__empty" data-smrt-part="empty">
                <span>{t(M['agents.run_history.no_run_history'])}</span>
              </div>
            {/if}
          </td>
        </tr>
      {:else}
        {#each history as entry (entry.id)}
          <tr
            class="smrt-agent-run-history__row" data-smrt-part="row"
            onclick={() => handleEntryClick(entry)}
            onkeydown={(event) => handleEntryKeydown(entry, event)}
            role={onEntryClick ? 'button' : undefined}
            tabindex={onEntryClick ? 0 : undefined}
          >
            <td class="smrt-agent-run-history__cell" data-smrt-part="cell">
              <Badge variant={getRunStatusVariant(entry.status)} size="sm">
                {entry.status === 'success' ? 'Success' : 'Failed'}
              </Badge>
            </td>
            <td class="smrt-agent-run-history__cell smrt-agent-run-history__cell-agent" data-smrt-part="cell">
              {entry.agentType}
            </td>
            <td class="smrt-agent-run-history__cell smrt-agent-run-history__cell-date" data-smrt-part="cell">
              {formatRelativeTime(entry.startedAt)}
            </td>
            <td class="smrt-agent-run-history__cell smrt-agent-run-history__cell-duration" data-smrt-part="cell">
              {formatDuration(entry.duration)}
            </td>
            <td class="smrt-agent-run-history__cell smrt-agent-run-history__cell-error" data-smrt-part="cell">
              {#if entry.error}
                <span class="smrt-agent-run-history__error" data-smrt-part="error" title={entry.error}>
                  {entry.error.length > 50 ? entry.error.slice(0, 50) + '...' : entry.error}
                </span>
              {:else}
                <span class="smrt-agent-run-history__no-error" data-smrt-part="meta">-</span>
              {/if}
            </td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-agent-run-history__root {
    width: 100%;
    overflow-x: auto;
  }
  .smrt-agent-run-history__table {
    width: 100%;
  }
  .smrt-agent-run-history__head th {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
    white-space: nowrap;
  }
  .smrt-agent-run-history__body tr:hover:not(.smrt-agent-run-history__row-loading):not(.smrt-agent-run-history__row-empty) {
    cursor: pointer;
  }
  .smrt-agent-run-history__cell {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
  }
  .smrt-agent-run-history__cell-date {
    white-space: nowrap;
  }
  .smrt-agent-run-history__cell-error {
    max-width: 300px;
  }
  .smrt-agent-run-history__error {
    cursor: help;
  }
  .smrt-agent-run-history__cell-loading,
  .smrt-agent-run-history__cell-empty {
    padding: var(--smrt-spacing-xl, 2rem);
  }
  .smrt-agent-run-history__progress {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-agent-run-history__spinner {
    width: 20px;
    height: 20px;
  }
  .smrt-agent-run-history__table.smrt-agent-run-history__loading {
    pointer-events: none;
  }
}

@layer smrt.theme {
  .smrt-agent-run-history__table {
    border-collapse: collapse;
    border-spacing: 0;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    background: var(--smrt-color-surface);
  }
  .smrt-agent-run-history__table.smrt-agent-run-history__loading {
    opacity: 0.7;
  }
  .smrt-agent-run-history__head {
    background: var(--smrt-color-surface-container);
  }
  .smrt-agent-run-history__head th {
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-align: left;
    border-bottom: var(--smrt-hairline);
  }
  .smrt-agent-run-history__body tr {
    border-bottom: var(--smrt-hairline);
    transition: background-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-agent-run-history__body tr:hover:not(.smrt-agent-run-history__row-loading):not(.smrt-agent-run-history__row-empty) {
    background: var(--smrt-color-surface-container-low);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-agent-run-history__body tr {
      transition: none;
    }
    .smrt-agent-run-history__spinner {
      animation: none;
    }
  }
  .smrt-agent-run-history__cell {
    vertical-align: middle;
  }
  .smrt-agent-run-history__cell-agent {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-agent-run-history__cell-date {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-run-history__cell-duration {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    text-align: center;
  }
  .smrt-agent-run-history__error {
    color: var(--smrt-color-error);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }
  .smrt-agent-run-history__no-error {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-run-history__cell-loading,
  .smrt-agent-run-history__cell-empty {
    text-align: center;
  }
  .smrt-agent-run-history__progress {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-run-history__spinner {
    border: 2px solid var(--smrt-color-outline-variant);
    border-top-color: var(--smrt-color-primary);
    border-radius: var(--smrt-radius-full);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .smrt-agent-run-history__empty {
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
