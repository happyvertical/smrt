<script lang="ts">
/** Props-only seller, advertiser registration and discount review surface. */
import { Form, FormGroup, Textarea } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import { formatCents } from '../format.js';
import type { SellerGovernanceAction, SellerGovernanceView } from '../types.js';
export interface Props {
  /** Host-authorized seller, advertiser lease and exact quote revision to display. */
  view: SellerGovernanceView;
  /** Prevents submitting another action while the host processes a request. */
  busy?: boolean;
  /** Sends an action intent to the host, which must authorize it through the service. */
  onAction?: (action: SellerGovernanceAction) => void;
}
let { view, busy = false, onAction }: Props = $props();
let reason = $state('');
function act(action: SellerGovernanceAction['action']) {
  onAction?.({
    action,
    quoteId: view.quote?.quoteId,
    revision: view.quote?.revision,
    requestId: view.quote?.approval?.requestId,
    leaseId: view.lease?.leaseId,
    reason: reason.trim(),
  });
}
</script>

<section data-smrt-component="SellerGovernancePanel" aria-label="Seller governance">
  <h3>{view.sellerLabel}</h3>
  <p>{view.authorized ? 'Authorized seller' : 'Seller authorization required'}</p>
  <h4>{view.advertiserLabel}</h4>
  {#if view.lease}
    <p>Registration {view.lease.released ? 'released' : 'expires'} {new Date(view.lease.expiresAtMs).toISOString()}</p>
    <Button disabled={busy || !view.authorized} onclick={() => act('renew')}>Renew registration</Button>
    <Button disabled={busy || !view.authorized} onclick={() => act('release')}>Release registration</Button>
  {:else}
    <Button disabled={busy || !view.authorized} onclick={() => act('acquire')}>Register advertiser</Button>
  {/if}
  {#if view.quote}
    <p>Quote revision {view.quote.revision}: {formatCents(view.quote.totalCents, view.quote.currency)} ({view.quote.status})</p>
    <p>Discount review: {view.quote.approval?.status ?? 'Not requested'}</p>
    {#if !view.quote.approval && view.quote.status === 'draft'}
      <Button disabled={busy || !view.authorized} onclick={() => act('request')}>Request discount approval</Button>
    {/if}
    {#if view.canReview && view.quote.approval}
      <Form onsubmit={() => {}}>
        <FormGroup label="Review reason" required>
          <Textarea name="discountReviewReason" value={reason} oninput={(event) => { reason = event.currentTarget.value; }} />
        </FormGroup>
        {#if view.quote.approval.status === 'pending'}
          <Button disabled={busy || !reason.trim()} onclick={() => act('approve')}>Approve</Button>
          <Button disabled={busy || !reason.trim()} onclick={() => act('reject')}>Reject</Button>
        {:else if view.quote.approval.status === 'approved'}
          <Button disabled={busy || !reason.trim()} onclick={() => act('revoke')}>Revoke approval</Button>
        {/if}
      </Form>
    {/if}
    {#if view.quote.status === 'draft'}
      <Button disabled={busy || !view.authorized} onclick={() => act('issue')}>Issue quote</Button>
    {:else if view.quote.status === 'issued'}
      <Button disabled={busy || !view.authorized} onclick={() => act('sign')}>Authorize signing</Button>
    {/if}
  {/if}
</section>
