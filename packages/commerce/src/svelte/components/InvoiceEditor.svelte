<script lang="ts">
import { CurrencyDisplay } from '@happyvertical/smrt-ui';
import {
  CurrencySelect,
  Form,
  FormGroup,
  Input,
  Select,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { calculateInvoiceDraft } from '../invoices/calculations.js';
import {
  invoiceFieldNames,
  invoiceLineFieldNames,
} from '../invoices/fields.js';
import { invoicePreparationMessages as M } from '../invoices/messages.js';
import type {
  InvoiceDraftValues,
  InvoiceEditorProps,
  InvoiceLineFieldNames,
} from '../invoices/types.js';
import InvoiceLineEditor from './InvoiceLineEditor.svelte';
import InvoiceReview from './InvoiceReview.svelte';
/** General native invoice editor; server owns prices, tax, authorization and persistence. */
export interface Props extends InvoiceEditorProps {}
let {
  action,
  method = 'post',
  id,
  title,
  values,
  customers = [],
  errors = {},
  fields = {},
  lineFields = {},
  canEdit = true,
  pending = false,
  retryStatus = 'idle',
  message,
  review,
  hiddenFields = [],
  saveIntent = 'save',
  addIntent = 'addLine',
  removePrefix = 'removeLine:',
  saveLabel,
  cancelHref,
  children,
  onsubmit,
}: Props = $props();
const { t } = useI18n();
const instanceId = $props.id();
const formId = $derived(id ?? `invoice-editor-${instanceId}`);
const names = $derived({ ...invoiceFieldNames, ...fields });
const rowNames = $derived({ ...invoiceLineFieldNames, ...lineFields });
const busy = $derived(
  pending || retryStatus === 'submitting' || retryStatus === 'busy',
);
let draft = $derived(values);
const calculation = $derived(calculateInvoiceDraft(draft));
function refresh(event: Event) {
  const data = new FormData(event.currentTarget as HTMLFormElement);
  const text = (name: string) => String(data.get(name) ?? '');
  draft = {
    ...draft,
    ...Object.fromEntries(
      Object.entries(names)
        .filter(([key]) => key !== 'intent')
        .map(([key, name]) => [key, text(name)]),
    ),
    lines: draft.lines.map((line, index) => ({
      ...line,
      ...Object.fromEntries(
        Object.entries(rowNames).map(([key, name]) => [
          key,
          String(data.getAll(name)[index] ?? ''),
        ]),
      ),
    })),
  } as InvoiceDraftValues;
}
function lineErrors(key: string) {
  return Object.fromEntries(
    Object.keys(rowNames).map((field) => [field, errors[`${key}.${field}`]]),
  ) as Partial<Record<keyof InvoiceLineFieldNames, string>>;
}
</script>
<section class="invoice-editor" aria-labelledby={`${formId}-title`}>
  <h2 id={`${formId}-title`}>{title ?? t(M['commerce.preparation.title'])}</h2>
  {#if review}<InvoiceReview {review} />{/if}
  {#if !canEdit}<p>{t(M['commerce.preparation.readonly'])}</p>{/if}
  <Form id={formId} {action} {method} preventDefault={false} {onsubmit} oninput={refresh} onchange={refresh} aria-busy={busy}>
    <div class="fields">
      {#if message}<p role="alert">{message}</p>{/if}
      {#if retryStatus === 'transport-error'}<p role="status">{t(M['commerce.preparation.uncertain'])}</p>{/if}
      {#each hiddenFields as field}<Input type="hidden" name={field.name} value={field.value} interaction={false} />{/each}
      {#if canEdit}<Button type="submit" name={names.intent} value={saveIntent} disabled={busy}>{saveLabel ?? t(M['commerce.preparation.save'])}</Button>{/if}
      <fieldset disabled={!canEdit} class="header-fields">
        <FormGroup id={`${formId}-customer`} label={t(M['commerce.invoice.customer'])} error={errors.customerId}>
          <Select name={names.customerId} value={draft.customerId}>
            <option value="">{t(M['commerce.invoice.chooseCustomer'])}</option>
            {#if draft.customerId && !customers.some(customer => customer.id === draft.customerId)}<option value={draft.customerId}>{t(M['commerce.invoice.retained'], { reference: draft.customerId })}</option>{/if}
            {#each customers as customer}<option value={customer.id}>{customer.label}</option>{/each}
          </Select>
        </FormGroup>
        <FormGroup id={`${formId}-issued`} label={t(M['commerce.invoice.issued'])} error={errors.issuedOn}><Input name={names.issuedOn} value={draft.issuedOn} /></FormGroup>
        <FormGroup id={`${formId}-due`} label={t(M['commerce.invoice.due'])} error={errors.dueOn}><Input name={names.dueOn} value={draft.dueOn} /></FormGroup>
        <FormGroup id={`${formId}-currency`} label={t(M['commerce.invoice.currency'])} error={errors.currency}><CurrencySelect name={names.currency} value={draft.currency} /></FormGroup>
        <FormGroup id={`${formId}-terms`} label={t(M['commerce.invoice.terms'])} error={errors.paymentTerms}><Input name={names.paymentTerms} value={draft.paymentTerms} /></FormGroup>
        <FormGroup id={`${formId}-tax`} label={t(M['commerce.invoice.defaultTax'])} error={errors.taxRate}><Input name={names.taxRate} value={draft.taxRate} inputmode="decimal" /></FormGroup>
      </fieldset>
      {#if draft.lines.length === 0}<p>{t(M['commerce.invoice.empty'])}</p>{/if}
      {#each draft.lines as line, index (line.key)}
        <InvoiceLineEditor {line} currency={draft.currency} inheritedTaxRate={draft.taxRate} number={index + 1} id={`${formId}-line-${index}`} fields={rowNames} errors={lineErrors(line.key)} {canEdit} pending={busy} intentField={names.intent} {removePrefix} />
      {/each}
      {#if canEdit}<Button type="submit" name={names.intent} value={addIntent} formnovalidate disabled={busy} variant="secondary">{t(M['commerce.invoice.add'])}</Button>{/if}
      <div aria-live="polite" class="summary">
        {#if calculation.valid}
          <dl>{#each ['gross', 'discount', 'subtotal', 'tax', 'total'] as key}<div><dt>{t(M[`commerce.invoice.${key}` as 'commerce.invoice.total'])}</dt><dd><CurrencyDisplay amount={calculation[`${key}Minor` as 'totalMinor']} currency={draft.currency} unit="cents" /></dd></div>{/each}</dl>
        {:else}<p>{t(M['commerce.invoice.invalid'])}</p>{/if}
      </div>
      <p>{t(M['commerce.invoice.preview'])}</p>
      {@render children?.(draft)}
      {#if cancelHref}<Button href={cancelHref} variant="ghost">{t(M['commerce.preparation.cancel'])}</Button>{/if}
    </div>
  </Form>
</section>
<style>
.invoice-editor, .fields, .header-fields { display: grid; grid-template-columns: minmax(0,1fr); gap: var(--smrt-spacing-4); min-width: 0; }
.invoice-editor { max-width: 48rem; overflow-wrap: anywhere; }
.header-fields { margin: 0; padding: 0; border: 0; }
h2, p, dl, dd { margin: 0; }
.summary dl { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-4); }
</style>
