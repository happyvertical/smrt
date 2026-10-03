<script lang="ts">
import {
  Form,
  FormGroup,
  Input,
  Select,
  Textarea,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { HTMLFormAttributes } from 'svelte/elements';
import { Q } from '../quote-i18n.js';
import {
  type QuoteDocumentKind,
  type QuoteDraftValues,
  type QuoteFieldNames,
  quoteFieldNames,
} from '../quote-types.js';

/** Narrow native attributes and Svelte attachment keys; avoids recursive HTML prop unions. */
export interface QuoteFormAttributes {
  /** Native form identity and encoding. */
  id?: string;
  /** Optional multipart encoding for caller-composed attachments. */
  enctype?: HTMLFormAttributes['enctype'];
  /** Native autocomplete setting. */
  autocomplete?: HTMLFormAttributes['autocomplete'];
  /** Svelte attachments, including caller-owned form-retry attachment. */
  [key: symbol]: Attachment<HTMLFormElement>;
}

/** Native quotation/estimate editor; caller retains data, authority and retry identity. */
export interface Props {
  /** Explicit domain of the document. */
  kind: QuoteDocumentKind;
  /** Server-rendered values, including rejected input strings. */
  values: QuoteDraftValues;
  /** Available authorized counterparties. */
  counterparties: { id: string; label: string }[];
  /** Native form destination; no routes are supplied by Commerce. */
  action: string;
  /** Native method (POST by default). */
  method?: 'post' | 'get';
  /** Caller-owned repeated hidden values, such as tenant/request/predecessor IDs. */
  hiddenFields?: { name: string; value: string }[];
  /** Override payload field names for existing endpoints. */
  names?: Partial<QuoteFieldNames>;
  /** Field errors keyed by canonical names or line ID plus field (e.g. a.description). */
  errors?: Record<string, string>;
  /** Server failure/uncertain outcome explanation; never clears the form. */
  message?: string;
  /** Presentation capability only; the server must enforce authorization. */
  readonly?: boolean;
  /** Disable writes while the caller handles a request. */
  busy?: boolean;
  /** Native submitter name and action values. Removal appends the stable line ID. */
  intents?: { name: string; save: string; add: string; removePrefix: string };
  /** Text overrides, including Client terminology. */
  labels?: { title?: string; counterparty?: string; save?: string };
  /** Optional navigation destination. */
  cancelHref?: string;
  /** Caller form enhancement; native submission remains enabled unless handler prevents it. */
  onsubmit?: HTMLFormAttributes['onsubmit'];
  /** Caller-controlled form attributes/attachments (e.g. createAttachmentKey for form-retry). */
  formAttributes?: QuoteFormAttributes;
  /** Domain-specific fields, such as allocation or source-selection controls. */
  extensions?: Snippet;
  /** Authorized attachment composition; this component never loads private files. */
  attachments?: Snippet;
}
let {
  kind,
  values,
  counterparties,
  action,
  method = 'post',
  hiddenFields = [],
  names = {},
  errors = {},
  message,
  readonly = false,
  busy = false,
  intents = {
    name: 'intent',
    save: 'save',
    add: 'addLine',
    removePrefix: 'removeLine:',
  },
  labels = {},
  cancelHref,
  onsubmit,
  formAttributes = {},
  extensions,
  attachments,
}: Props = $props();
const { t } = useI18n();
const fields = $derived({ ...quoteFieldNames, ...names });
const title = $derived(
  labels.title ??
    t(
      Q[
        kind === 'vendor-quotation'
          ? 'commerce.quote.vendor'
          : 'commerce.quote.estimate'
      ],
    ),
);
</script>

<section class="quote-editor" aria-label={title}>
  <h2>{title}</h2>
  <p>{t(Q[kind === 'vendor-quotation' ? 'commerce.quote.vendor_hint' : 'commerce.quote.estimate_hint'])}</p>
  {#if readonly}<p>{t(Q['commerce.quote.readonly'])}</p>{/if}
  {#if message}<p role="alert">{message}</p>{/if}
  <Form {...formAttributes} {action} {method} {onsubmit} preventDefault={false}>
    {#each hiddenFields as field}<Input type="hidden" name={field.name} value={field.value} />{/each}
    <fieldset disabled={readonly || busy}>
      <legend>{title}</legend>
      {#if !readonly}<div class="actions"><Button type="submit" name={intents.name} value={intents.save} density="touch">{labels.save ?? t(Q['commerce.quote.save'])}</Button></div>{/if}
      <FormGroup label={labels.counterparty ?? t(Q[kind === 'vendor-quotation' ? 'commerce.quote.vendor_party' : 'commerce.quote.customer_party'])} error={errors.counterpartyId} required>
        <Select name={fields.counterpartyId} value={values.counterpartyId} required density="touch">
          <option value="">{t(Q['commerce.quote.choose'])}</option>
          {#if values.counterpartyId && !counterparties.some(party => party.id === values.counterpartyId)}<option value={values.counterpartyId}>{values.counterpartyId}</option>{/if}
          {#each counterparties as party}<option value={party.id}>{party.label}</option>{/each}
        </Select>
      </FormGroup>
      {#each [{key:'reference',label:'commerce.quote.reference'}, {key:'date',label:'commerce.quote.date'}, {key:'validUntil',label:'commerce.quote.expiry'}, {key:'currency',label:'commerce.quote.currency'}, {key:'total',label:'commerce.quote.total'}, {key:'tax',label:'commerce.quote.tax'}] as field}
        <FormGroup label={t(Q[field.label as keyof typeof Q])} error={errors[field.key]}>
          <Input name={fields[field.key as keyof QuoteFieldNames]} value={values[field.key as 'reference']} inputmode={field.key === 'total' || field.key === 'tax' ? 'decimal' : undefined} density="touch" />
        </FormGroup>
      {/each}
      {#each [{key:'scope',label:'commerce.quote.scope'}, {key:'inclusions',label:'commerce.quote.inclusions'}, {key:'exclusions',label:'commerce.quote.exclusions'}, {key:'reason',label:'commerce.quote.reason'}] as field}
        <FormGroup label={t(Q[field.label as keyof typeof Q])} error={errors[field.key]}>
          <Textarea name={fields[field.key as keyof QuoteFieldNames]} value={values[field.key as 'scope']} />
        </FormGroup>
      {/each}
      <h3>{t(Q['commerce.quote.lines'])}</h3>
      {#each values.lines as line, index (line.id)}
        <fieldset>
          <legend>{t(Q['commerce.quote.line'], {number: index + 1})}</legend>
          <Input type="hidden" name={fields.lineId} value={line.id} />
          <FormGroup label={t(Q['commerce.quote.description'])} error={errors[`${line.id}.description`]}><Input name={fields.lineDescription} value={line.description} density="touch" /></FormGroup>
          <FormGroup label={t(Q['commerce.quote.quantity'])} error={errors[`${line.id}.quantity`]}><Input name={fields.lineQuantity} value={line.quantity} inputmode="decimal" density="touch" /></FormGroup>
          <FormGroup label={t(Q['commerce.quote.rate'])} error={errors[`${line.id}.unitRate`]}><Input name={fields.lineUnitRate} value={line.unitRate} inputmode="decimal" density="touch" /></FormGroup>
          {#if !readonly}<Button type="submit" name={intents.name} value={`${intents.removePrefix}${line.id}`} formnovalidate variant="secondary" density="touch">{t(Q['commerce.quote.remove'], {number: index + 1})}</Button>{/if}
        </fieldset>
      {:else}<p>{t(Q['commerce.quote.empty_lines'])}</p>{/each}
      {#if !readonly}<Button type="submit" name={intents.name} value={intents.add} formnovalidate variant="secondary" density="touch">{t(Q['commerce.quote.add'])}</Button>{/if}
      {@render extensions?.()}
      {@render attachments?.()}
    </fieldset>
    {#if cancelHref}<Button href={cancelHref} variant="secondary" density="touch">{t(Q['commerce.quote.cancel'])}</Button>{/if}
  </Form>
</section>

<style>
.quote-editor { max-width: 48rem; min-width: 0; color: var(--smrt-color-on-surface); overflow-wrap: anywhere; }
fieldset { min-width: 0; margin-block: var(--smrt-spacing-4, 1rem); padding: var(--smrt-spacing-4, 1rem); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-md, 0.5rem); }
.actions { margin-top: var(--smrt-spacing-4, 1rem); }
</style>
