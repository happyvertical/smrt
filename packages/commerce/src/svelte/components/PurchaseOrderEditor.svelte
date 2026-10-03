<script lang="ts">
import {
  Checkbox,
  Form,
  FormGroup,
  Input,
  Select,
  Textarea,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import type { HTMLFormAttributes } from 'svelte/elements';
import { P } from '../purchasing-i18n.js';
import {
  type PurchaseDraftValues,
  type PurchaseFieldNames,
  type PurchaseReviewSnapshot,
  type PurchaseSourceOption,
  purchaseFieldNames,
} from '../purchasing-types.js';
import { quoteMinorText } from '../quote-types.js';
import type { QuoteFormAttributes } from './QuoteEditor.svelte';

/** Native purchase/award preparation, review and explicit confirmation; never writes a record. */
export interface Props {
  /** Caller-selected operation; reducing retains every predecessor allocation. */
  operation?: 'create' | 'amend' | 'reduce';
  /** Retained source. For reductions, the server must enforce predecessor/source identity. */
  source: PurchaseSourceOption;
  /** Currency and decimal places come from the owning financial contract. */
  currency: string;
  /** Explicit currency/asset scale (0–8); amounts entered in ordinary major units. */
  minorUnitDigits: number;
  /** Raw submitted values, including errors and explicit zero amounts. */
  values: PurchaseDraftValues;
  /** Caller-approved instrument choices, with no fixed construction policy. */
  instruments: { value: string; label: string }[];
  /** Native POST action URL. */
  action: string;
  /** Caller-owned tenant/request/source/predecessor IDs. */
  hiddenFields?: { name: string; value: string }[];
  /** Existing route field-name adaptation. */
  names?: Partial<PurchaseFieldNames>;
  /** Canonical field errors or allocation IDs. */
  errors?: Record<string, string>;
  /** Server validation or uncertain-outcome message. */
  message?: string;
  /** Server-produced review snapshot. Omit until explicit review succeeds. */
  review?: PurchaseReviewSnapshot;
  /** Previously reviewed fingerprint retained after an uncertain committed response. */
  retryFingerprint?: string;
  /** Presentation capability; caller must independently enforce authority. */
  readonly?: boolean;
  /** Disable writes while caller transport is in flight. */
  busy?: boolean;
  /** Native submitter names and values expected by the caller. */
  intents?: { name: string; review: string; record: string; edit: string };
  /** Optional row editing. Retained reduction rows cannot be removed. */
  rowActions?: { add: string; removePrefix: string };
  /** Caller confirmation value; a new review fingerprint requires fresh confirmation. */
  confirmationValue?: string;
  /** Application-specific labels, including the explicit approval statement. */
  labels?: {
    title?: string;
    review?: string;
    record?: string;
    confirmation?: string;
    allocations?: string;
  };
  /** Optional navigation URL. */
  cancelHref?: string;
  /** Native form enhancement; caller prevents default when handling transport. */
  onsubmit?: HTMLFormAttributes['onsubmit'];
  /** Native encoding/ID and caller-owned Svelte form-retry attachments. */
  formAttributes?: QuoteFormAttributes;
  /** Domain-specific allocation, policy or source evidence composition. */
  extensions?: Snippet;
  /** Authorized private attachment presentation, never loaded by Commerce. */
  attachments?: Snippet;
}
let {
  operation = 'create',
  source,
  currency,
  minorUnitDigits,
  values,
  instruments,
  action,
  hiddenFields = [],
  names = {},
  errors = {},
  message,
  review,
  retryFingerprint,
  readonly = false,
  busy = false,
  intents = {
    name: 'intent',
    review: 'review',
    record: 'record',
    edit: 'edit',
  },
  rowActions,
  confirmationValue = 'yes',
  labels = {},
  cancelHref,
  onsubmit,
  formAttributes = {},
  extensions,
  attachments,
}: Props = $props();
const { t } = useI18n();
const fields = $derived({ ...purchaseFieldNames, ...names });
const title = $derived(
  labels.title ??
    t(
      P[
        operation === 'reduce'
          ? 'commerce.purchase.reduce'
          : operation === 'amend'
            ? 'commerce.purchase.amend'
            : 'commerce.purchase.create'
      ],
    ),
);
const fingerprint = $derived(review?.fingerprint ?? retryFingerprint);
const money = (amountMinor: number | null) =>
  quoteMinorText({ currency, minorUnitDigits, amountMinor }) ??
  t(P['commerce.purchase.unknown']);
</script>
<section class="purchase-editor" aria-label={title}>
 <h2>{title}</h2>
 <p>{t(P['commerce.purchase.boundary'])}</p>
 <p>{source.vendor} — {source.label} · {currency}</p>
 {#if source.notice}<p role="status">{source.notice}</p>{/if}
 {#if operation==='reduce'}<p>{t(P['commerce.purchase.reduction_hint'])}</p>{/if}
 {#if readonly}<p>{t(P['commerce.purchase.readonly'])}</p>{/if}
 {#if message}<p role="alert">{message}</p>{/if}
 <Form {...formAttributes} {action} method="post" {onsubmit} preventDefault={false}>
  {#each hiddenFields as field}<Input type="hidden" name={field.name} value={field.value} />{/each}
  <fieldset disabled={readonly || busy || source.disabled}>
   <legend>{title}</legend>
   <!-- The first submitter is the safe default for native Enter-in-input submission. -->
   {#if !readonly}<Button type="submit" name={intents.name} value={fingerprint ? intents.record : intents.review} density="touch">{fingerprint ? labels.record??t(P['commerce.purchase.record']) : labels.review??t(P['commerce.purchase.review_button'])}</Button>{/if}
   <FormGroup label={t(P['commerce.purchase.instrument'])} error={errors.instrument} required>
    <Select name={fields.instrument} value={values.instrument} required density="touch">
     <option value="">{t(P['commerce.purchase.choose_instrument'])}</option>
     {#if values.instrument && !instruments.some(item=>item.value===values.instrument)}<option value={values.instrument}>{values.instrument}</option>{/if}
     {#each instruments as item}<option value={item.value}>{item.label}</option>{/each}
    </Select>
   </FormGroup>
   <fieldset>
    <legend>{labels.allocations??t(P['commerce.purchase.allocations'])} ({currency})</legend>
    {#each values.allocations as allocation (allocation.id)}
     <div class="allocation">
      <Input type="hidden" name={fields.allocationId} value={allocation.id} />
      <FormGroup label={allocation.label} error={errors[allocation.id]} required={operation==='reduce' && allocation.retained || allocation.required}>
       <Input name={fields.allocationAmount} value={allocation.amount} inputmode="decimal" required={operation==='reduce' && allocation.retained || allocation.required} density="touch" />
      </FormGroup>
      {#if allocation.sourceMinor !== undefined}<p>{t(P['commerce.purchase.source_amount'])}: {money(allocation.sourceMinor)} {currency}</p>{/if}
      {#if allocation.minimumMinor !== undefined}<p>{t(P['commerce.purchase.minimum'])}: {money(allocation.minimumMinor)} {currency}</p>{/if}
      {#if allocation.maximumMinor !== undefined}<p>{t(P['commerce.purchase.maximum'])}: {money(allocation.maximumMinor)} {currency}</p>{/if}
      {#if rowActions && !readonly && !(operation==='reduce' && allocation.retained)}<Button type="submit" name={intents.name} value={`${rowActions.removePrefix}${allocation.id}`} formnovalidate variant="secondary" density="touch">{t(P['commerce.purchase.remove'],{label:allocation.label})}</Button>{/if}
     </div>
    {:else}<p>{t(P['commerce.purchase.empty_allocations'])}</p>{/each}
    {#if rowActions && !readonly}<Button type="submit" name={intents.name} value={rowActions.add} formnovalidate variant="secondary" density="touch">{t(P['commerce.purchase.add'])}</Button>{/if}
   </fieldset>
   <FormGroup label={`${t(P['commerce.purchase.tax'])} (${currency})`} error={errors.tax} required><Input name={fields.tax} value={values.tax} inputmode="decimal" required density="touch" /></FormGroup>
   {#each [{key:'scope',label:'commerce.purchase.scope'}, {key:'inclusions',label:'commerce.purchase.inclusions'}, {key:'exclusions',label:'commerce.purchase.exclusions'}, {key:'reason',label:'commerce.purchase.reason'}] as field}
    <FormGroup label={t(P[field.label as keyof typeof P])} error={errors[field.key]} required={field.key==='scope' || field.key==='reason'}><Textarea name={fields[field.key as keyof PurchaseFieldNames]} value={values[field.key as 'scope']} required={field.key==='scope' || field.key==='reason'} /></FormGroup>
   {/each}
   {@render extensions?.()}
   {@render attachments?.()}
   {#if fingerprint}
    <h3>{t(P['commerce.purchase.review'])}</h3>
    {#if review}
     <p>{review.sourceLabel}</p><p>{t(P['commerce.purchase.total'])}: {quoteMinorText(review.total)??t(P['commerce.purchase.unknown'])} {review.total.currency}</p>
     <p>{t(P['commerce.purchase.tax'])}: {quoteMinorText({...review.total,amountMinor:review.taxMinor})} {review.total.currency}</p>
     <p>{review.scope}</p>{#each review.notices??[] as notice}<p role="status">{notice}</p>{/each}
    {:else}<p>{t(P['commerce.purchase.uncertain'])}</p>{/if}
    <Input type="hidden" name={fields.fingerprint} value={fingerprint} />
    {#if !readonly}
     {#key fingerprint}<Checkbox name={fields.confirmation} value={confirmationValue} label={labels.confirmation??t(P['commerce.purchase.confirm'])} required density="touch" />{/key}
     <div class="actions"><Button type="submit" name={intents.name} value={intents.record} density="touch">{labels.record??t(P['commerce.purchase.record'])}</Button><Button type="submit" name={intents.name} value={intents.edit} formnovalidate variant="secondary" density="touch">{t(P['commerce.purchase.edit'])}</Button></div>
    {/if}
   {:else if !readonly}<Button type="submit" name={intents.name} value={intents.review} density="touch">{labels.review??t(P['commerce.purchase.review_button'])}</Button>{/if}
  </fieldset>
  {#if cancelHref}<Button href={cancelHref} variant="secondary" density="touch">{t(P['commerce.purchase.cancel'])}</Button>{/if}
 </Form>
</section>
<style>
.purchase-editor{max-width:48rem;min-width:0;overflow-wrap:anywhere;color:var(--smrt-color-on-surface)}
fieldset{min-width:0;margin-block:var(--smrt-spacing-4,1rem);padding:var(--smrt-spacing-4,1rem);border:1px solid var(--smrt-color-outline-variant);border-radius:var(--smrt-radius-md,0.5rem)}
.allocation{margin-block:var(--smrt-spacing-4,1rem)}
.actions{display:flex;flex-wrap:wrap;gap:var(--smrt-spacing-3,0.75rem);margin-block:var(--smrt-spacing-4,1rem)}
</style>
