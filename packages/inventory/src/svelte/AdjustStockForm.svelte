<script lang="ts">
import { Form, FormGroup, Input } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { StockAdjustmentInput } from './types.js';
export interface Props {
  skuId: string;
  locationId: string;
  onsubmit: (input: StockAdjustmentInput) => Promise<void> | void;
  disabled?: boolean;
}
const { skuId, locationId, onsubmit, disabled = false }: Props = $props();
let delta = $state<string | number>('');
let reasonCode = $state('adjustment');
let note = $state('');
let pending = $state(false);
let error = $state('');
let saved = $state(false);
async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (pending || disabled) return;
  error = '';
  saved = false;
  const quantity = Number(delta);
  if (
    !skuId.trim() ||
    !locationId.trim() ||
    !Number.isFinite(quantity) ||
    quantity === 0 ||
    !reasonCode.trim()
  ) {
    error = 'Choose a SKU and location, a non-zero quantity, and a reason.';
    return;
  }
  pending = true;
  try {
    await onsubmit({
      skuId,
      locationId,
      delta: quantity,
      reasonCode: reasonCode.trim(),
      note,
    });
    saved = true;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Unable to adjust stock.';
  } finally {
    pending = false;
  }
}
</script>
<Form onsubmit={submit} aria-label="Adjust stock">
  <p>SKU: {skuId} · Location: {locationId}</p>
  <FormGroup label="Quantity adjustment"><Input type="number" step="any" bind:value={delta} required disabled={disabled || pending} /></FormGroup>
  <FormGroup label="Reason"><Input bind:value={reasonCode} required disabled={disabled || pending} /></FormGroup>
  <FormGroup label="Note"><Input bind:value={note} disabled={disabled || pending} /></FormGroup>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if saved}<p role="status">Stock adjusted</p>{/if}
  <Button type="submit" disabled={disabled || pending}>{pending ? 'Saving…' : 'Adjust stock'}</Button>
</Form>
