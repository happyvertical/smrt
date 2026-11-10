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

<section class="smrt-payout-batch-review__root" data-smrt-component="PayoutBatchReview">
  {#if payouts.length === 0}
    <p class="smrt-payout-batch-review__empty" data-smrt-part="empty">No payout batches to review.</p>
  {:else}
    {#each payouts as payout (payout.id)}
      {@const actions = payoutActionsFor(payout.status)}
      <Card variant="outlined">
        <div class="smrt-payout-batch-review__header" data-smrt-part="header">
          <span class="smrt-payout-batch-review__earner">{payout.earnerName ?? 'Earner'}</span>
          <Badge variant={payoutStatusBadgeVariant(payout.status)} size="sm">
            {payout.status}
          </Badge>
        </div>

        <dl class="smrt-payout-batch-review__facts" data-smrt-part="facts">
          <div class="smrt-payout-batch-review__fact">
            <dt>Period</dt>
            <dd>
              {formatDate(payout.periodStart, locale)} – {formatDate(payout.periodEnd, locale)}
            </dd>
          </div>
          <div class="smrt-payout-batch-review__fact">
            <dt>Method</dt>
            <dd>{methodLabel(payout.payoutMethod)}</dd>
          </div>
          <div class="smrt-payout-batch-review__fact">
            <dt>Commissions</dt>
            <dd>{formatCents(payout.commissionTotalCents, payout.currency, locale)}</dd>
          </div>
          <div class="smrt-payout-batch-review__fact">
            <dt>Adjustments</dt>
            <dd class:smrt-payout-batch-review__negative={payout.adjustmentTotalCents < 0}>
              {formatCents(payout.adjustmentTotalCents, payout.currency, locale)}
            </dd>
          </div>
          <div class="smrt-payout-batch-review__fact smrt-payout-batch-review__fact--net">
            <dt>Net</dt>
            <dd class:smrt-payout-batch-review__negative={payout.totalAmountCents < 0}>
              {formatCents(payout.totalAmountCents, payout.currency, locale)}
            </dd>
          </div>
        </dl>

        {#if payout.status === 'completed' && payout.paymentReference}
          <p class="smrt-payout-batch-review__settled" data-smrt-part="message">
            Settled with reference <code>{payout.paymentReference}</code>
            {#if payout.paidAt}
              on {formatDate(payout.paidAt, locale)}
            {/if}
          </p>
        {/if}

        {#if (payout.status === 'failed' || payout.status === 'rejected') && payout.notes}
          <p class="smrt-payout-batch-review__failed-note" data-smrt-part="error">{payout.notes}</p>
        {/if}

        {#if actions.canApprove && onApprove}
          <div class="smrt-payout-batch-review__actions" data-smrt-part="actions">
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
          <div class="smrt-payout-batch-review__actions" data-smrt-part="actions">
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
          <div class="smrt-payout-batch-review__actions smrt-payout-batch-review__actions--form" data-smrt-part="actions">
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
          <div class="smrt-payout-batch-review__actions smrt-payout-batch-review__actions--form" data-smrt-part="actions">
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
          <div class="smrt-payout-batch-review__actions smrt-payout-batch-review__actions--form" data-smrt-part="actions">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-payout-batch-review__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
  }
  .smrt-payout-batch-review__empty {
    margin: 0;
  }
  .smrt-payout-batch-review__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin-bottom: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-payout-batch-review__facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4, 1rem);
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-payout-batch-review__fact dd {
    margin: 0;
  }
  .smrt-payout-batch-review__settled {
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-payout-batch-review__failed-note {
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-payout-batch-review__actions {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin-top: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-payout-batch-review__actions--form :global([data-smrt-component="FormGroup"]) {
    margin-bottom: 0;
    flex: 1 1 14rem;
  }
}

@layer smrt.theme {
  .smrt-payout-batch-review__empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  .smrt-payout-batch-review__earner {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-payout-batch-review__fact dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .smrt-payout-batch-review__fact--net dd {
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  .smrt-payout-batch-review__negative {
    color: var(--smrt-color-error);
  }
  .smrt-payout-batch-review__failed-note {
    color: var(--smrt-color-error);
  }
  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
}

</style>
