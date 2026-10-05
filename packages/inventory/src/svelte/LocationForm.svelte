<script lang="ts">
import { Checkbox, FormGroup, Input } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import { untrack } from 'svelte';
import type { InventoryLocationData } from './types.js';
export interface Props {
  location?: InventoryLocationData;
  onsubmit: (input: InventoryLocationData) => Promise<void> | void;
  disabled?: boolean;
}
const { location, onsubmit, disabled = false }: Props = $props();
let code = $state(untrack(() => location?.code ?? ''));
let name = $state(untrack(() => location?.name ?? ''));
let kind = $state(untrack(() => location?.kind ?? 'warehouse'));
let placeId = $state(untrack(() => location?.placeId ?? ''));
let active = $state(untrack(() => location?.active ?? true));
let pending = $state(false);
let error = $state('');
let saved = $state(false);
$effect(() => {
  code = location?.code ?? '';
  name = location?.name ?? '';
  kind = location?.kind ?? 'warehouse';
  placeId = location?.placeId ?? '';
  active = location?.active ?? true;
  saved = false;
  error = '';
});
async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (pending || disabled) return;
  error = '';
  saved = false;
  if (!code.trim() || !name.trim() || !kind.trim()) {
    error = 'Code, name, and kind are required.';
    return;
  }
  pending = true;
  try {
    await onsubmit({
      id: location?.id,
      code: code.trim(),
      name: name.trim(),
      kind: kind.trim(),
      placeId: placeId.trim(),
      active,
    });
    saved = true;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Unable to save location.';
  } finally {
    pending = false;
  }
}
</script>
<form onsubmit={submit} aria-label="Inventory location">
  <FormGroup label="Code"><Input bind:value={code} required disabled={disabled || pending} /></FormGroup>
  <FormGroup label="Name"><Input bind:value={name} required disabled={disabled || pending} /></FormGroup>
  <FormGroup label="Kind"><Input bind:value={kind} required disabled={disabled || pending} /></FormGroup>
  <FormGroup label="Place ID"><Input bind:value={placeId} disabled={disabled || pending} /></FormGroup>
  <Checkbox label="Active" bind:checked={active} disabled={disabled || pending} />
  {#if error}<p role="alert">{error}</p>{/if}
  {#if saved}<p role="status">Location saved</p>{/if}
  <Button type="submit" disabled={disabled || pending}>{pending ? 'Saving…' : 'Save location'}</Button>
</form>
