<script lang="ts">
import {
  CameraCapture,
  Form,
  FormGroup,
  Input,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { expenseMessages as M } from '../messages.js';
import type { ExpenseReceiptCaptureProps } from '../types.js';
/** Separate multipart receipt action; storage and attachment remain server-owned. */
export interface Props extends ExpenseReceiptCaptureProps {}
let {
  action,
  hiddenFields = [],
  fileField = 'receipt',
  fileName = 'receipt.jpg',
  canAttach = false,
  pending = false,
  message,
  intentField = 'intent',
  intent = 'attach-receipt',
  onsubmit,
}: Props = $props();
const { t } = useI18n();
let camera = $state(false);
const id = $props.id();
</script>
<section class="receipt-capture" aria-label={t(M['expenses.receipt.title'])}>
  <h3>{t(M['expenses.receipt.title'])}</h3>
  {#if message}<p role="alert">{message}</p>{/if}
  <p>{t(M['expenses.receipt.reselect'])}</p>
  {#if canAttach}
    <Form {action} method="post" enctype="multipart/form-data" preventDefault={false} {onsubmit} aria-busy={pending}>
      {#each hiddenFields as field}<Input type="hidden" name={field.name} value={field.value} interaction={false} />{/each}
      <Button type="button" disabled={pending} aria-pressed={camera} onclick={() => { camera = !camera; }}>{t(M['expenses.receipt.camera'])}</Button>
      {#if camera}
        <CameraCapture name={fileField} {fileName} disabled={pending} />
      {:else}
        <FormGroup id={`receipt-${id}`} label={t(M['expenses.receipt.file'])}>
          <Input type="file" name={fileField} accept="image/*,application/pdf" disabled={pending} />
        </FormGroup>
      {/if}
      <Button type="submit" name={intentField} value={intent} disabled={pending}>{t(M['expenses.receipt.save'])}</Button>
    </Form>
  {/if}
</section>
<style>
  .receipt-capture { display: grid; gap: var(--smrt-spacing-3); min-width: 0; overflow-wrap: anywhere; }
  h3, p { margin: 0; }
</style>
