<script lang="ts">
import {
  Checkbox,
  FormGroup,
  Input,
  Select,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { invoicePreparationMessages as M } from '../invoices/messages.js';
import type { InvoiceAllocationFieldsProps } from '../invoices/types.js';
/** Optional allocation fields; compose inside a caller-owned invoice form. */
export interface Props extends InvoiceAllocationFieldsProps {}
let {
  currency,
  allocations,
  sources = [],
  mayReadSources = true,
  canEdit = true,
  pending = false,
  fields = {},
  addIntent = 'addAllocation',
  id,
}: Props = $props();
const { t } = useI18n();
const instanceId = $props.id();
const formId = $derived(id ?? `invoice-allocations-${instanceId}`);
const names = $derived({
  source: 'sourceId',
  amount: 'allocationAmount',
  remove: 'removeRow',
  intent: 'intent',
  ...fields,
});
</script>
<div class="allocations">
  {#if !mayReadSources}<p>{t(M['commerce.preparation.restricted'])}</p>
  {:else if sources.length === 0}<p>{t(M['commerce.preparation.empty'])}</p>{/if}
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
{#if canEdit}<Button type="submit" name={names.intent} value={addIntent} formnovalidate disabled={pending} variant="secondary">{t(M['commerce.preparation.add'])}</Button>{/if}
</div>
<style>
.allocations { display: grid; gap: var(--smrt-spacing-4); min-width: 0; }
fieldset { min-width: 0; margin: 0; padding: var(--smrt-spacing-4); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-small); }
p { margin: 0; }
</style>
