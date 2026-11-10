<script lang="ts">
/**
 * TimeEntryApprovalQueue — reusable time-entry review list (issue #1930,
 * moved to smrt-timesheets in #3288): date, hours, description, worker,
 * status, and the client charge amount at a glance, with approve/reject
 * actions on `submitted` rows. Presentational: the host loads entries (e.g.
 * through `ServiceTimeEntryCollection`), adapts them to
 * `TimeEntryApprovalView` (smrt-support's `toSupportTimeEntryView` does this
 * for support entries), and wires `onapprove` / `onreject` to its approval
 * service.
 */

import { Button, StatusBadge } from '@happyvertical/smrt-ui';
import { Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import { M } from '../i18n.js';
import {
  humanizeTimeEntryStatus,
  type TimeEntryApprovalView,
  timeEntryStatusBadgeKey,
} from '../types.js';
import {
  currencyMinorUnitExponent,
  formatHours,
  type HoursFormatter,
} from './utils.js';

const { t } = useI18n();

export interface TimeEntryApprovalQueueProps {
  /** Array of time entries awaiting approval review. */
  entries: TimeEntryApprovalView[];
  /** Callback invoked with entry ID when approving a time entry. */
  onapprove?: (id: string) => void;
  /** Callback invoked with entry ID and rejection reason when rejecting a time entry. */
  onreject?: (id: string, reason: string) => void;
  /** Message displayed when the approval queue is empty. */
  emptyMessage?: string;
  /** Formats decimal hours; defaults to the legacy one-decimal display. */
  hoursFormatter?: HoursFormatter;
  /** Renders caller-owned evidence for each entry. */
  details?: Snippet<[TimeEntryApprovalView]>;
  /** Replaces callback actions with caller-owned controls, including native forms. */
  actions?: Snippet<[TimeEntryApprovalView]>;
}

const {
  entries,
  onapprove,
  onreject,
  emptyMessage,
  hoursFormatter = formatHours,
  details,
  actions,
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
  const digits = currencyMinorUnitExponent(currency);
  return (amount / 10 ** digits).toFixed(digits);
}
</script>

{#if entries.length === 0}
  <p class="smrt-time-entry-approval-queue__empty" data-smrt-component="TimeEntryApprovalQueue">
    {emptyMessage ?? t(M['timesheets.approval_queue.empty'])}
  </p>
{:else}
  <ul class="smrt-time-entry-approval-queue__root" data-smrt-component="TimeEntryApprovalQueue">
    {#each entries as entry (entry.id)}
      <li class="smrt-time-entry-approval-queue__row" data-smrt-part="row">
        <div class="smrt-time-entry-approval-queue__line" data-smrt-part="body">
          <span class="smrt-time-entry-approval-queue__date" data-smrt-part="date">{entry.date}</span>
          <span class="smrt-time-entry-approval-queue__main" data-smrt-part="title">
            <span class="smrt-time-entry-approval-queue__description" data-smrt-part="description">{entry.description}</span>
            {#if entry.workerName}
              <span class="smrt-time-entry-approval-queue__worker" data-smrt-part="meta">{entry.workerName}</span>
            {/if}
          </span>
          <span class="smrt-time-entry-approval-queue__meta" data-smrt-part="stats">
            <span class="smrt-time-entry-approval-queue__hours" data-smrt-part="value">{hoursFormatter(entry.hours)}</span>
            <StatusBadge
              status={timeEntryStatusBadgeKey(entry.status)}
              label={humanizeTimeEntryStatus(entry.status)}
              size="sm"
            />
            {#if entry.amount !== undefined}
              <span class="smrt-time-entry-approval-queue__amount" data-smrt-part="amount">
                {formatAmount(entry.amount, entry.currency)}
              </span>
            {/if}
          </span>
        </div>
        {@render details?.(entry)}
        {#if entry.status === 'submitted'}
          <div class="smrt-time-entry-approval-queue__actions" data-smrt-part="actions">
            {#if actions}
              {@render actions(entry)}
            {:else if rejectingId === entry.id}
              <Input
                bind:value={rejectReason}
                placeholder={t(M['timesheets.approval_queue.reason_placeholder'])}
                aria-label={t(M['timesheets.approval_queue.reason_aria'], { description: entry.description })}
              />
              <Button
                variant="danger"
                size="sm"
                disabled={rejectReason.trim().length === 0}
                onclick={() => confirmReject(entry.id)}
                aria-label={t(M['timesheets.approval_queue.confirm_reject_aria'], { description: entry.description })}
              >
                {t(M['timesheets.approval_queue.confirm_reject'])}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onclick={cancelReject}
                aria-label={t(M['timesheets.approval_queue.cancel_aria'], { description: entry.description })}
              >
                {t(M['timesheets.approval_queue.cancel'])}
              </Button>
            {:else}
              <Button
                variant="primary"
                size="sm"
                onclick={() => onapprove?.(entry.id)}
                aria-label={t(M['timesheets.approval_queue.approve_aria'], { description: entry.description })}
              >
                {t(M['timesheets.approval_queue.approve'])}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onclick={() => beginReject(entry.id)}
                aria-label={t(M['timesheets.approval_queue.reject_aria'], { description: entry.description })}
              >
                {t(M['timesheets.approval_queue.reject'])}
              </Button>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-time-entry-approval-queue__root {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .smrt-time-entry-approval-queue__row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem 0.25rem;
  }
  .smrt-time-entry-approval-queue__line {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .smrt-time-entry-approval-queue__date {
    flex-shrink: 0;
  }
  .smrt-time-entry-approval-queue__main {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }
  .smrt-time-entry-approval-queue__description {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-time-entry-approval-queue__meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .smrt-time-entry-approval-queue__actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  .smrt-time-entry-approval-queue__empty {
    padding: 1rem 0;
  }
}

@layer smrt.theme {
  .smrt-time-entry-approval-queue__row {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-time-entry-approval-queue__row:last-child {
    border-bottom: none;
  }
  .smrt-time-entry-approval-queue__line {
    text-align: left;
  }
  .smrt-time-entry-approval-queue__date {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-time-entry-approval-queue__description {
    font-weight: 500;
  }
  .smrt-time-entry-approval-queue__worker {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-time-entry-approval-queue__hours {
    font-weight: 500;
    color: var(--smrt-color-primary, inherit);
  }
  .smrt-time-entry-approval-queue__amount {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }
  .smrt-time-entry-approval-queue__empty {
    color: var(--smrt-color-on-surface-variant, inherit);
  }
}

</style>
