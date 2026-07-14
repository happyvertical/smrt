<script lang="ts">
/**
 * PayoutBatchReview — operator settlement approvals (#1933).
 *
 * One card per payout batch with actions gated by the batch status
 * (`pending → approved → processing → completed | failed`, plus the
 * terminal decline `rejected` from pending/approved): approve, reject
 * (requires a reason), start processing, complete (requires a payment
 * reference), and mark failed (requires a reason). The gating mirrors the
 * CommissionPayout transition guard via the pure `payoutActionsFor`
 * helper.
 */
import { FormGroup, Input } from '@happyvertical/smrt-ui/forms';
import { Badge, Button, Card } from '@happyvertical/smrt-ui/ui';
import { formatCents, formatDate } from '../format.js';
import type { PayoutBatchReviewItemView } from '../types.js';
import { payoutActionsFor, payoutStatusBadgeVariant } from '../types.js';

export interface Props {
  /** Payout batches under operator review. */
  payouts?: PayoutBatchReviewItemView[];
  /** Disable actions while a mutation is in flight. */
  busy?: boolean;
  /** BCP 47 locale for money/date formatting. */
  locale?: string;
  /** Approve a pending batch. */
  onApprove?: (payoutId: string) => void;
  /** Move an approved batch into processing. */
  onMarkProcessing?: (payoutId: string) => void;
  /** Complete a processing batch with the settlement payment reference. */
  onComplete?: (payoutId: string, paymentReference: string) => void;
  /** Mark an approved/processing batch failed with a reason. */
  onFail?: (payoutId: string, reason: string) => void;
  /**
   * Reject a pending/approved batch with a reason (terminal decline —
   * the service releases the batch's membership for a future batch).
   */
  onReject?: (payoutId: string, reason: string) => void;
}

let {
  payouts = [],
  busy = false,
  locale,
  onApprove,
  onMarkProcessing,
  onComplete,
  onFail,
  onReject,
}: Props = $props();

// Per-payout drafts.
let referenceDrafts = $state<Record<string, string>>({});
let failReasonDrafts = $state<Record<string, string>>({});
let rejectReasonDrafts = $state<Record<string, string>>({});

function setReference(payoutId: string, value: string) {
  referenceDrafts = { ...referenceDrafts, [payoutId]: value };
}

function setFailReason(payoutId: string, value: string) {
  failReasonDrafts = { ...failReasonDrafts, [payoutId]: value };
}

function setRejectReason(payoutId: string, value: string) {
  rejectReasonDrafts = { ...rejectReasonDrafts, [payoutId]: value };
}

function complete(payoutId: string) {
  const reference = (referenceDrafts[payoutId] ?? '').trim();
  if (reference !== '') onComplete?.(payoutId, reference);
}

function fail(payoutId: string) {
  const reason = (failReasonDrafts[payoutId] ?? '').trim();
  if (reason !== '') onFail?.(payoutId, reason);
}

function reject(payoutId: string) {
  const reason = (rejectReasonDrafts[payoutId] ?? '').trim();
  if (reason !== '') onReject?.(payoutId, reason);
}

function methodLabel(method: string): string {
  return method.replace(/_/g, ' ');
}
</script>

<section class="sales-payout-review">
  {#if payouts.length === 0}
    <p class="empty">No payout batches to review.</p>
  {:else}
    {#each payouts as payout (payout.id)}
      {@const actions = payoutActionsFor(payout.status)}
      <Card variant="outlined">
        <div class="head">
          <span class="head__earner">{payout.earnerName ?? 'Earner'}</span>
          <Badge variant={payoutStatusBadgeVariant(payout.status)} size="sm">
            {payout.status}
          </Badge>
        </div>

        <dl class="facts">
          <div class="facts__item">
            <dt>Period</dt>
            <dd>
              {formatDate(payout.periodStart, locale)} – {formatDate(payout.periodEnd, locale)}
            </dd>
          </div>
          <div class="facts__item">
            <dt>Method</dt>
            <dd>{methodLabel(payout.payoutMethod)}</dd>
          </div>
          <div class="facts__item">
            <dt>Commissions</dt>
            <dd>{formatCents(payout.commissionTotalCents, payout.currency, locale)}</dd>
          </div>
          <div class="facts__item">
            <dt>Adjustments</dt>
            <dd class:negative={payout.adjustmentTotalCents < 0}>
              {formatCents(payout.adjustmentTotalCents, payout.currency, locale)}
            </dd>
          </div>
          <div class="facts__item facts__item--net">
            <dt>Net</dt>
            <dd class:negative={payout.totalAmountCents < 0}>
              {formatCents(payout.totalAmountCents, payout.currency, locale)}
            </dd>
          </div>
        </dl>

        {#if payout.status === 'completed' && payout.paymentReference}
          <p class="settled">
            Settled with reference <code>{payout.paymentReference}</code>
            {#if payout.paidAt}
              on {formatDate(payout.paidAt, locale)}
            {/if}
          </p>
        {/if}

        {#if (payout.status === 'failed' || payout.status === 'rejected') && payout.notes}
          <p class="failed-note">{payout.notes}</p>
        {/if}

        {#if actions.canApprove && onApprove}
          <div class="actions">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onclick={() => onApprove?.(payout.id)}
            >
              Approve
            </Button>
          </div>
        {/if}

        {#if actions.canMarkProcessing && onMarkProcessing}
          <div class="actions">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onclick={() => onMarkProcessing?.(payout.id)}
            >
              Start processing
            </Button>
          </div>
        {/if}

        {#if actions.canComplete && onComplete}
          <div class="actions actions--form">
            <FormGroup
              label="Payment reference"
              required
              hint="Bank/provider reference recorded on the completed batch."
            >
              <Input
                value={referenceDrafts[payout.id] ?? ''}
                disabled={busy}
                oninput={(event) =>
                  setReference(
                    payout.id,
                    (event.currentTarget as HTMLInputElement).value,
                  )}
              />
            </FormGroup>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || (referenceDrafts[payout.id] ?? '').trim() === ''}
              onclick={() => complete(payout.id)}
            >
              Complete
            </Button>
          </div>
        {/if}

        {#if actions.canFail && onFail}
          <div class="actions actions--form">
            <FormGroup label="Failure reason" required>
              <Input
                value={failReasonDrafts[payout.id] ?? ''}
                disabled={busy}
                oninput={(event) =>
                  setFailReason(
                    payout.id,
                    (event.currentTarget as HTMLInputElement).value,
                  )}
              />
            </FormGroup>
            <Button
              variant="danger"
              size="sm"
              disabled={busy || (failReasonDrafts[payout.id] ?? '').trim() === ''}
              onclick={() => fail(payout.id)}
            >
              Mark failed
            </Button>
          </div>
        {/if}

        {#if actions.canReject && onReject}
          <div class="actions actions--form">
            <FormGroup
              label="Rejection reason"
              required
              hint="Terminal decline — the batch's rows return to unsettled for a future batch."
            >
              <Input
                value={rejectReasonDrafts[payout.id] ?? ''}
                disabled={busy}
                oninput={(event) =>
                  setRejectReason(
                    payout.id,
                    (event.currentTarget as HTMLInputElement).value,
                  )}
              />
            </FormGroup>
            <Button
              variant="danger"
              size="sm"
              disabled={busy ||
                (rejectReasonDrafts[payout.id] ?? '').trim() === ''}
              onclick={() => reject(payout.id)}
            >
              Reject
            </Button>
          </div>
        {/if}
      </Card>
    {/each}
  {/if}
</section>

<style>
  .sales-payout-review {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
  }

  .empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-style: italic;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin-bottom: var(--smrt-spacing-2, 0.5rem);
  }

  .head__earner {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4, 1rem);
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
  }

  .facts__item dt {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .facts__item dd {
    margin: 0;
  }

  .facts__item--net dd {
    font-weight: var(--smrt-typography-weight-bold, 700);
  }

  .negative {
    color: var(--smrt-color-error, #dc2626);
  }

  .settled {
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
  }

  .failed-note {
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
    color: var(--smrt-color-error, #dc2626);
  }

  .actions {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin-top: var(--smrt-spacing-2, 0.5rem);
  }

  .actions--form :global(.form-group) {
    margin-bottom: 0;
    flex: 1 1 14rem;
  }

  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
</style>
