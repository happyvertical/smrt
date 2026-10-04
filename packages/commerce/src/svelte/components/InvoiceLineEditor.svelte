<script lang="ts">
import { CurrencyDisplay } from '@happyvertical/smrt-ui';
import { FormGroup, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { calculateInvoiceLine } from '../invoices/calculations.js';
import { invoiceLineFieldNames } from '../invoices/fields.js';
import { invoicePreparationMessages as M } from '../invoices/messages.js';
import type { InvoiceLineEditorProps } from '../invoices/types.js';
/** General invoice line fields and exact non-authoritative calculation preview. */
export interface Props extends InvoiceLineEditorProps {}
let {
  line,
  currency,
  inheritedTaxRate,
  number = 1,
  id,
  fields = {},
  errors = {},
  canEdit = true,
  pending = false,
  intentField = 'intent',
  removePrefix = 'removeLine:',
}: Props = $props();
const { t } = useI18n();
const instanceId = $props.id();
const prefix = $derived(id ?? `invoice-line-${instanceId}`);
const names = $derived({ ...invoiceLineFieldNames, ...fields });
const calculation = $derived(
  calculateInvoiceLine(line, { currency, inheritedTaxRate }),
);
</script>
<fieldset disabled={!canEdit} class="invoice-line">
  <legend>{t(M['commerce.invoice.line'], { number })}</legend>
  <Input type="hidden" name={names.key} value={line.key} interaction={false} />
  {#each ['description', 'sku', 'quantity', 'unitPrice'] as field}
    <FormGroup id={`${prefix}-${field}`} label={t(M[`commerce.invoice.${field}` as 'commerce.invoice.description'], { currency })} error={errors[field as keyof typeof errors]}>
      <Input name={names[field as keyof typeof names]} value={line[field as 'description']} inputmode={field === 'quantity' || field === 'unitPrice' ? 'decimal' : undefined} />
    </FormGroup>
  {/each}
  <FormGroup id={`${prefix}-discountType`} label={t(M['commerce.invoice.discountType'])} error={errors.discountType}>
    <Select name={names.discountType} value={line.discountType}>
      {#if line.discountType !== 'flat' && line.discountType !== 'percent'}<option value={line.discountType}>{line.discountType}</option>{/if}
      <option value="flat">{t(M['commerce.invoice.flat'])}</option><option value="percent">{t(M['commerce.invoice.percent'])}</option>
    </Select>
  </FormGroup>
  <FormGroup id={`${prefix}-discountValue`} label={t(M['commerce.invoice.discountValue'])} error={errors.discountValue}><Input name={names.discountValue} value={line.discountValue} inputmode="decimal" /></FormGroup>
  <FormGroup id={`${prefix}-taxMode`} label={t(M['commerce.invoice.taxMode'])} error={errors.taxMode}>
    <Select name={names.taxMode} value={line.taxMode}>
      {#if line.taxMode !== 'inherit' && line.taxMode !== 'override'}<option value={line.taxMode}>{line.taxMode}</option>{/if}
      <option value="inherit">{t(M['commerce.invoice.inherit'])}</option><option value="override">{t(M['commerce.invoice.override'])}</option>
    </Select>
  </FormGroup>
  <FormGroup id={`${prefix}-taxRate`} label={t(M['commerce.invoice.taxRate'])} error={errors.taxRate}><Input name={names.taxRate} value={line.taxRate} inputmode="decimal" /></FormGroup>
  {#if calculation.valid}
    <dl class="totals">
      <div><dt>{t(M['commerce.invoice.subtotal'])}</dt><dd><CurrencyDisplay amount={calculation.subtotalMinor} {currency} unit="cents" /></dd></div>
      <div><dt>{t(M['commerce.invoice.tax'])}</dt><dd><CurrencyDisplay amount={calculation.taxMinor} {currency} unit="cents" /></dd></div>
      <div><dt>{t(M['commerce.invoice.total'])}</dt><dd><CurrencyDisplay amount={calculation.totalMinor} {currency} unit="cents" /></dd></div>
    </dl>
  {:else}<p role="status">{t(M['commerce.invoice.invalid'])}</p>{/if}
  {#if canEdit}<Button type="submit" name={intentField} value={`${removePrefix}${line.key}`} formnovalidate disabled={pending} variant="secondary">{t(M['commerce.invoice.remove'])}</Button>{/if}
</fieldset>
<style>
.invoice-line { display: grid; grid-template-columns: minmax(0,1fr); gap: var(--smrt-spacing-3); min-width: 0; margin: 0; padding: var(--smrt-spacing-4); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-small); }
legend { padding-inline: var(--smrt-spacing-2); }
.totals { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-4); }
dd { margin: 0; } p, dl { margin: 0; }
</style>
