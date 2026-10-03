<script lang="ts">
import {
  Checkbox,
  Form,
  FormGroup,
  Input,
  Select,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { invoicePreparationMessages as M } from '../invoices/messages.js';
import type { InvoiceEditorProps } from '../invoices/types.js';
import InvoiceReview from './InvoiceReview.svelte';

/** Native invoice preparation with caller-owned transport, values and authority. */
export interface Props extends InvoiceEditorProps {}
let {
  action,
  method = 'post',
  id,
  title,
  currency,
  allocations,
  sources = [],
  mayReadSources = true,
  canEdit = true,
  pending = false,
  retryStatus = 'idle',
  message,
  review,
  hiddenFields = [],
  fields = {},
  saveIntent = 'save',
  addIntent = 'addAllocation',
  saveLabel,
  cancelHref,
  children,
  onsubmit,
}: Props = $props();
const { t } = useI18n();
const instanceId = $props.id();
const formId = $derived(id ?? `invoice-editor-${instanceId}`);
const names = $derived({
  source: 'sourceId',
  amount: 'allocationAmount',
  remove: 'removeRow',
  intent: 'intent',
  ...fields,
});
const busy = $derived(
  pending || retryStatus === 'submitting' || retryStatus === 'busy',
);
</script>

<section class="invoice-editor" aria-labelledby={`${formId}-title`}>
  <h2 id={`${formId}-title`}>{title ?? t(M['commerce.preparation.title'])}</h2>
  {#if review}<InvoiceReview {review} />{/if}
  {#if !canEdit}<p>{t(M['commerce.preparation.readonly'])}</p>{/if}
  {#if !mayReadSources}<p>{t(M['commerce.preparation.restricted'])}</p>
  {:else if sources.length === 0}<p>{t(M['commerce.preparation.empty'])}</p>{/if}
  <Form id={formId} {action} {method} preventDefault={false} {onsubmit} aria-busy={busy}>
    <div class="fields">
      {#if message}<p role="alert">{message}</p>{/if}
      {#if retryStatus === 'transport-error'}<p role="status">{t(M['commerce.preparation.uncertain'])}</p>{/if}
      {#each hiddenFields as field}<Input type="hidden" name={field.name} value={field.value} interaction={false} />{/each}
      {#if allocations.length === 0}<p>{t(M['commerce.preparation.no_rows'])}</p>{/if}
      {#each allocations as allocation, index (allocation.key)}
        <fieldset disabled={!canEdit}>
          <legend>{t(M['commerce.preparation.allocation'], { number: index + 1 })}</legend>
          <FormGroup label={t(M[mayReadSources ? 'commerce.preparation.source' : 'commerce.preparation.reference'])} id={`${formId}-source-${index}`} error={allocation.sourceError}>
            {#if mayReadSources}
              <Select name={names.source} value={allocation.sourceId} interaction={{ id: `source-${allocation.key}` }}>
                <option value="">{t(M['commerce.preparation.choose'])}</option>
                {#if allocation.sourceId && !sources.some(source => source.id === allocation.sourceId)}
                  <option value={allocation.sourceId}>{t(M['commerce.preparation.retained'], { reference: allocation.sourceId })}</option>
                {/if}
                {#each sources as source}
                  <option value={source.id} disabled={source.selectable === false && source.id !== allocation.sourceId}>{t(M['commerce.preparation.available'], { label: source.label, amount: source.availableMinor, currency })}</option>
                {/each}
              </Select>
            {:else}
              <Input name={names.source} value={allocation.sourceId} interaction={{ id: `source-${allocation.key}` }} />
            {/if}
          </FormGroup>
          <FormGroup label={t(M['commerce.preparation.amount'], { currency })} id={`${formId}-amount-${index}`} error={allocation.amountError}>
            <Input name={names.amount} value={allocation.amount} inputmode="decimal" aria-describedby={allocation.amountError ? `${formId}-amount-${index}-error` : `${formId}-help`} interaction={{ id: `amount-${allocation.key}` }} />
          </FormGroup>
          {#if canEdit}<Checkbox name={names.remove} value={String(index)} checked={allocation.remove ?? false} label={t(M['commerce.preparation.remove'])} interaction={{ id: `remove-${allocation.key}` }} />{/if}
        </fieldset>
      {/each}
      <p id={`${formId}-help`}>{t(M['commerce.preparation.help'])}</p>
      {@render children?.()}
      <div class="actions">
        {#if cancelHref}<Button href={cancelHref} variant="ghost">{t(M['commerce.preparation.cancel'])}</Button>{/if}
        {#if canEdit}
          <Button type="submit" name={names.intent} value={addIntent} formnovalidate disabled={busy} variant="secondary">{t(M['commerce.preparation.add'])}</Button>
          <Button type="submit" name={names.intent} value={saveIntent} disabled={busy}>{saveLabel ?? t(M['commerce.preparation.save'])}</Button>
        {/if}
      </div>
    </div>
  </Form>
</section>

<style>
  .invoice-editor, .fields { display: grid; gap: var(--smrt-spacing-4); min-width: 0; }
  .invoice-editor { max-width: 48rem; overflow-wrap: anywhere; }
  fieldset { min-width: 0; margin: 0; padding: var(--smrt-spacing-4); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-small); }
  legend { padding-inline: var(--smrt-spacing-2); }
  h2, p { margin: 0; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-3); }
</style>
