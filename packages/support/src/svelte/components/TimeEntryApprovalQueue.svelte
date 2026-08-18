<script lang="ts">
/**
 * TimeEntryApprovalQueue — reusable Service Time Entry review list (issue
 * #1930): date, hours, description, worker, status, and the client charge
 * amount at a glance, with approve/reject actions on `submitted` rows.
 * Presentational: the host loads entries through `TimeEntryApprovalService`
 * / `ServiceTimeEntryCollection`, adapts them with `toSupportTimeEntryView`,
 * and wires `onapprove` / `onreject` to the approval service.
 */

import { Button, StatusBadge } from '@happyvertical/smrt-ui';
import { Input } from '@happyvertical/smrt-ui/forms';
import {
  humanizeStatus,
  type SupportTimeEntryView,
  timeEntryStatusBadgeKey,
} from '../types.js';

export interface TimeEntryApprovalQueueProps {
  entries: SupportTimeEntryView[];
  onapprove?: (id: string) => void;
  onreject?: (id: string, reason: string) => void;
  emptyMessage?: string;
}

const {
  entries,
  onapprove,
  onreject,
  emptyMessage = 'No time entries',
}: TimeEntryApprovalQueueProps = $props();

/** The entry currently collecting a rejection reason (one at a time). */
let rejectingId = $state<string | null>(null);
let rejectReason = $state('');

function beginReject(id: string): void {
  rejectingId = id;
  rejectReason = '';
}

function cancelReject(): void {
  rejectingId = null;
  rejectReason = '';
}

function confirmReject(id: string): void {
  const reason = rejectReason.trim();
  if (!reason) return;
  onreject?.(id, reason);
  cancelReject();
}

function formatHours(hours: number): string {
  return `${hours.toFixed(1)}h`;
}

/**
 * Render a minor-units charge for display.
 *
 * `amount` is integer minor units (#2401), so `toFixed(2)` would print 180
 * cents as "180.00" — a hundredfold overstatement. The scale is the currency's
 * own minor-unit exponent rather than a hard-coded 100, so a zero-decimal
 * currency (JPY, KRW) is not divided at all and a three-decimal one (BHD) is
 * divided by 1000. No currency symbol is added: the queue shows a bare figure
 * and the host app supplies the label.
 */
function formatAmount(amount: number, currency = 'USD'): string {
  const digits =
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  return (amount / 10 ** digits).toFixed(digits);
}
</script>

{#if entries.length === 0}
  <p class="time-approval-empty">{emptyMessage}</p>
{:else}
  <ul class="time-approval-queue">
    {#each entries as entry (entry.id)}
      <li class="time-approval-row">
        <div class="time-approval-line">
          <span class="time-approval-date">{entry.date}</span>
          <span class="time-approval-main">
            <span class="time-approval-description">{entry.description}</span>
            {#if entry.workerName}
              <span class="time-approval-worker">{entry.workerName}</span>
            {/if}
          </span>
          <span class="time-approval-meta">
            <span class="time-approval-hours">{formatHours(entry.hours)}</span>
            <StatusBadge
              status={timeEntryStatusBadgeKey(entry.status)}
              label={humanizeStatus(entry.status)}
              size="sm"
            />
            {#if entry.amount !== undefined}
              <span class="time-approval-amount">
                {formatAmount(entry.amount, entry.currency)}
              </span>
            {/if}
          </span>
        </div>
        {#if entry.status === 'submitted'}
          <div class="time-approval-actions">
            {#if rejectingId === entry.id}
              <Input
                bind:value={rejectReason}
                placeholder="Rejection reason"
                aria-label={`Rejection reason for: ${entry.description}`}
              />
              <Button
                variant="danger"
                size="sm"
                disabled={rejectReason.trim().length === 0}
                onclick={() => confirmReject(entry.id)}
                aria-label={`Confirm rejection of: ${entry.description}`}
              >
                Confirm reject
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onclick={cancelReject}
                aria-label={`Cancel rejecting: ${entry.description}`}
              >
                Cancel
              </Button>
            {:else}
              <Button
                variant="primary"
                size="sm"
                onclick={() => onapprove?.(entry.id)}
                aria-label={`Approve time entry: ${entry.description}`}
              >
                Approve
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onclick={() => beginReject(entry.id)}
                aria-label={`Reject time entry: ${entry.description}`}
              >
                Reject
              </Button>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .time-approval-queue {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .time-approval-row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem 0.25rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant, transparent);
  }

  .time-approval-row:last-child {
    border-bottom: none;
  }

  .time-approval-line {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    text-align: left;
  }

  .time-approval-date {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .time-approval-main {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }

  .time-approval-description {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time-approval-worker {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .time-approval-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .time-approval-hours {
    font-weight: 500;
    color: var(--smrt-color-primary, inherit);
  }

  .time-approval-amount {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }

  .time-approval-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-content: flex-end;
  }

  .time-approval-empty {
    color: var(--smrt-color-on-surface-variant, inherit);
    padding: 1rem 0;
  }
</style>
