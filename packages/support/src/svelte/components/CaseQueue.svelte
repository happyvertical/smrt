<script lang="ts">
/**
 * CaseQueue — reusable Support Case queue list (issue #1926): priority,
 * status, assignment, and channel at a glance. Presentational: the host
 * fetches `SupportCaseView[]` (see `toSupportCaseView`) and wires `onselect`.
 */

import { Button, StatusBadge } from '@happyvertical/smrt-ui';
import {
  caseStatusBadgeKey,
  humanizeStatus,
  priorityBadgeKey,
  type SupportCaseView,
} from '../types.js';

export interface CaseQueueProps {
  cases: SupportCaseView[];
  onselect?: (caseId: string) => void;
  emptyMessage?: string;
  /** Show the assigned-specialist column (default true). */
  showAssignee?: boolean;
}

const {
  cases,
  onselect,
  emptyMessage = 'No support cases',
  showAssignee = true,
}: CaseQueueProps = $props();

function formatUpdated(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
</script>

{#if cases.length === 0}
  <p class="case-queue-empty">{emptyMessage}</p>
{:else}
  <ul class="case-queue">
    {#each cases as item (item.id)}
      <li class="case-queue-row">
        <Button
          variant="ghost"
          fullWidth
          onclick={() => onselect?.(item.id)}
          aria-label={`Open case ${item.caseNumber}: ${item.subject}`}
        >
          <span class="case-queue-line">
            <span class="case-queue-main">
              <span class="case-queue-number">{item.caseNumber}</span>
              <span class="case-queue-subject">{item.subject}</span>
            </span>
            <span class="case-queue-meta">
              <StatusBadge
                status={priorityBadgeKey(item.priority)}
                label={item.priority}
                size="sm"
              />
              <StatusBadge
                status={caseStatusBadgeKey(item.status)}
                label={humanizeStatus(item.status)}
                size="sm"
              />
              {#if item.channelKind}
                <span class="case-queue-channel">{item.channelKind}</span>
              {/if}
              {#if showAssignee}
                <span class="case-queue-assignee">
                  {item.assignedSpecialistName ??
                    (item.assignedSpecialistId ? 'assigned' : 'unassigned')}
                </span>
              {/if}
              <span class="case-queue-updated">
                {formatUpdated(item.updatedAt)}
              </span>
            </span>
          </span>
        </Button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .case-queue {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .case-queue-line {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    text-align: left;
  }

  .case-queue-main {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .case-queue-number {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .case-queue-subject {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .case-queue-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .case-queue-channel,
  .case-queue-assignee,
  .case-queue-updated {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .case-queue-empty {
    color: var(--smrt-color-on-surface-variant, inherit);
    padding: 1rem 0;
  }
</style>
