<script lang="ts">
import { CurrencyDisplay } from '@happyvertical/smrt-ui';
import { Input, Select } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { HTMLFormAttributes } from 'svelte/elements';
import {
  calculateMoneyEditorDraft,
  type MoneyEditorProps,
  moneyEditorFieldNames,
} from '../invoices/money-editor.js';

export interface Props {
  action: string;
  method?: 'post' | 'get';
  money: MoneyEditorProps;
  canEdit?: boolean;
  pending?: boolean;
  hiddenFields?: readonly { name: string; value: string }[];
  intentField?: string;
  saveIntent?: string;
  saveLabel?: string;
  onsubmit?: HTMLFormAttributes['onsubmit'];
}

let {
  action,
  method = 'post',
  money,
  canEdit = true,
  pending = false,
  hiddenFields = [],
  intentField = 'intent',
  saveIntent = 'save',
  saveLabel = 'Save invoice draft',
  onsubmit,
}: Props = $props();

const names = $derived({ ...moneyEditorFieldNames, ...money.names });
// The selector owns a local pending choice until the native form submits.
// svelte-ignore state_referenced_locally
let lineAmountType = $state(money.draft.lineAmountType);
// svelte-ignore state_referenced_locally
let lines = $state([...money.draft.lines]);
let modeConfirmed = $state(false);
const frozen = $derived(money.frozen === true);
const editable = $derived(canEdit && !frozen);
const calculation = $derived(
  calculateMoneyEditorDraft(
    { ...money.draft, lineAmountType, lines },
    money.taxCodes,
  ),
);
const result = $derived(calculation.valid ? calculation.result : null);
const stored = $derived(money.stored);
const totals = $derived(
  frozen && stored
    ? stored
    : result
      ? {
          lineAmountType,
          roundingScope: money.draft.roundingScope,
          subtotalMinor: result.subtotalMinor,
          discountTotalMinor: result.discountTotalMinor,
          taxMinor: result.taxMinor,
          totalMinor: result.totalMinor,
          taxes: result.taxes.map((tax) => {
            const code = money.taxCodes.find(
              (candidate) => candidate.id === tax.taxCodeId,
            );
            const component = code?.components.find(
              (candidate) => candidate.taxComponentId === tax.taxComponentId,
            );
            return {
              id: `${tax.taxCodeId}:${tax.taxComponentId ?? ''}`,
              taxComponentId: tax.taxComponentId,
              name:
                code?.componentNames?.[tax.taxComponentId ?? ''] ??
                code?.name ??
                code?.code ??
                'Tax',
              percent: component?.percent ?? '0',
              taxableMinor: tax.taxableMinor,
              taxMinor: tax.taxMinor,
            };
          }),
        }
      : null,
);

function inheritedHint(line: MoneyEditorProps['draft']['lines'][number]) {
  const code = money.taxCodes.find(
    (candidate) => candidate.id === line.inheritedTaxCodeId,
  );
  if (!code) return 'No tax code';
  const source =
    line.inheritedTaxCodeSource === 'exempt-customer'
      ? 'customer is exempt'
      : line.inheritedTaxCodeSource === 'customer'
        ? 'from customer'
        : line.inheritedTaxCodeSource === 'product'
          ? 'from product'
          : 'app default';
  return `${code.code} · ${source}`;
}

function groupedTaxes(
  taxes: readonly {
    id: string;
    taxComponentId?: string | null;
    name: string;
    percent: string;
    taxableMinor: number;
    taxMinor: number;
  }[],
) {
  const rows = new Map<
    string,
    {
      id: string;
      taxComponentId?: string | null;
      name: string;
      percent: string;
      taxableMinor: number;
      taxMinor: number;
    }
  >();
  for (const tax of taxes) {
    const key = `${tax.taxComponentId ?? tax.id}\u0000${tax.name}\u0000${tax.percent}`;
    const current = rows.get(key);
    if (current) {
      current.taxableMinor += tax.taxableMinor;
      current.taxMinor += tax.taxMinor;
    } else rows.set(key, { ...tax });
  }
  return [...rows.values()];
}

function patchLine(
  index: number,
  patch: Partial<MoneyEditorProps['draft']['lines'][number]>,
) {
  lines[index] = { ...lines[index], ...patch };
}

function changeDiscount(index: number, event: Event) {
  const discountType = (event.currentTarget as HTMLSelectElement)
    .value as MoneyEditorProps['draft']['lines'][number]['discountType'];
  patchLine(index, { discountType, discountValue: '' });
}

function changeTaxCode(index: number, event: Event) {
  const taxCodeId = (event.currentTarget as HTMLSelectElement).value;
  patchLine(index, {
    taxCodeId: taxCodeId || null,
    taxMode: taxCodeId ? 'override' : 'inherit',
  });
}

function changeMode(event: Event) {
  const next = (event.currentTarget as HTMLSelectElement)
    .value as typeof lineAmountType;
  if (next === lineAmountType) return;
  if (
    money.draft.lines.length > 0 &&
    !modeConfirmed &&
    typeof window !== 'undefined' &&
    !window.confirm('Keep the prices as typed and recompute tax?')
  ) {
    (event.currentTarget as HTMLSelectElement).value = lineAmountType;
    return;
  }
  modeConfirmed = true;
  lineAmountType = next;
}
</script>

<section class="invoice-editor money-editor" aria-label="Invoice money" data-smrt-component="InvoiceEditor" data-money-model="v2">
  {#if frozen}
    <p role="status">Frozen{money.status ? ` · ${money.status}` : ''}</p>
  {/if}
  {#if money.sellerTaxRegistrations?.length || money.partyTaxId}
    <p class="tax-registrations">
      {#each money.sellerTaxRegistrations ?? [] as registration}{registration}{#if money.partyTaxId || registration !== money.sellerTaxRegistrations?.at(-1)} · {/if}{/each}
      {#if money.partyTaxId}{money.partyTaxId}{/if}
    </p>
  {/if}
  <form {action} {method} {onsubmit} aria-busy={pending}>
    {#each hiddenFields as field}<Input type="hidden" name={field.name} value={field.value} interaction={false} />{/each}
    <fieldset disabled={!editable || pending}>
      <label>
        Amounts are
        <Select name={names.lineAmountType} value={lineAmountType} onchange={changeMode}>
          <option value="exclusive">Tax exclusive</option>
          <option value="inclusive">Tax inclusive</option>
          <option value="none">No tax</option>
        </Select>
      </label>
      <Input type="hidden" name={names.roundingScope} value={money.draft.roundingScope} interaction={false} />
      {#if money.customerTaxExempt && lineAmountType === 'inclusive'}<p>Customer is exempt: prices unchanged, no tax extracted.</p>{/if}
      {#each lines as line, index (line.id)}
        <fieldset class="money-line">
          <legend>Invoice line {index + 1}</legend>
          <Input type="hidden" name={names.lineId} value={line.id} interaction={false} />
          <label>Description <Input name={names.lineDescription} value={line.description} oninput={(event) => patchLine(index, { description: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label>Quantity <Input name={names.lineQuantity} value={line.quantity} inputmode="decimal" oninput={(event) => patchLine(index, { quantity: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label>Unit price <Input name={names.lineUnitPrice} value={line.unitPrice} inputmode="decimal" oninput={(event) => patchLine(index, { unitPrice: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label>Discount type
            <Select name={names.lineDiscountType} value={line.discountType} onchange={(event) => changeDiscount(index, event)}>
              <option value="none">None</option><option value="percent">%</option><option value="amount">$</option>
            </Select>
          </label>
          <label>Discount <Input name={names.lineDiscountValue} value={line.discountValue} inputmode="decimal" oninput={(event) => patchLine(index, { discountValue: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label>Tax code
            <Select name={names.lineTaxCodeId} value={line.taxMode === 'override' ? line.taxCodeId ?? '' : ''} onchange={(event) => changeTaxCode(index, event)}>
              <option value="">{inheritedHint(line)}</option>
              {#each money.taxCodes as code}<option value={code.id}>{code.code}</option>{/each}
            </Select>
          </label>
          <Input type="hidden" name={names.lineTaxMode} value={line.taxMode} interaction={false} />
          {#if money.customerTaxExempt && line.taxMode === 'override'}<p role="status">Customer is exempt; this line is taxed by override.</p>{/if}
        </fieldset>
      {/each}
    </fieldset>
    {#if editable}<Button type="submit" name={intentField} value={saveIntent} disabled={pending}>{saveLabel}</Button>{/if}
  </form>
  {#if !totals}
    <p role="alert">{calculation.valid ? 'Stored totals are required for a frozen document.' : calculation.message}</p>
  {:else}
    <dl class="summary" aria-live="polite">
      {#if totals.lineAmountType !== 'inclusive'}
        <div><dt>Subtotal</dt><dd><CurrencyDisplay amount={totals.subtotalMinor} currency={money.draft.currency} unit="cents" /></dd></div>
      {/if}
      {#if totals.discountTotalMinor !== 0}<div class="muted"><dt>Includes discounts of <CurrencyDisplay amount={Math.abs(totals.discountTotalMinor)} currency={money.draft.currency} unit="cents" /></dt></div>{/if}
      {#each groupedTaxes(totals.taxes).filter((tax) => tax.taxMinor !== 0) as tax (tax.id)}
        <div class:muted={totals.lineAmountType === 'inclusive'}>
          <dt>{totals.lineAmountType === 'inclusive' ? `Includes ${tax.name} ${tax.percent}% of` : `${tax.name} ${tax.percent}% on`} <CurrencyDisplay amount={totals.lineAmountType === 'inclusive' ? tax.taxMinor : tax.taxableMinor} currency={money.draft.currency} unit="cents" /></dt>
          {#if totals.lineAmountType !== 'inclusive'}<dd><CurrencyDisplay amount={tax.taxMinor} currency={money.draft.currency} unit="cents" /></dd>{/if}
        </div>
      {/each}
      {#if totals.roundingScope === 'document'}<div class="muted"><dt>Rounded per document</dt></div>{/if}
      <div class="total"><dt>Total</dt><dd><CurrencyDisplay amount={totals.totalMinor} currency={money.draft.currency} unit="cents" /></dd></div>
      {#if totals.lineAmountType === 'inclusive' && money.showNetSubtotal}<div><dt>Subtotal (excl. tax)</dt><dd><CurrencyDisplay amount={totals.subtotalMinor} currency={money.draft.currency} unit="cents" /></dd></div>{/if}
    </dl>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .money-editor, form, fieldset, .money-line { display: grid; gap: var(--smrt-spacing-3); min-width: 0; }
  .money-editor { max-width: 48rem; overflow-wrap: anywhere; }
  .summary { display: grid; gap: var(--smrt-spacing-2); }
  .summary > div { display: flex; justify-content: space-between; gap: var(--smrt-spacing-4); }
  .summary .muted { color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-small-font-size); }
  .summary .total { border-top: var(--smrt-hairline-strong); padding-top: var(--smrt-spacing-2); font-weight: var(--smrt-typography-weight-semibold); }
  dd { margin: 0; }
}
</style>
