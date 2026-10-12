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
import type { HTMLFormAttributes } from 'svelte/elements';
import { P } from '../purchasing-i18n.js';
import type { PurchaseOrderHeaderValues } from '../purchasing-types.js';
import type { QuoteFormAttributes } from './QuoteEditor.svelte';

/** Native header-only form; it never changes source allocations or writes a record. */
export interface Props {
  /** Caller-owned native POST endpoint. */
  action: string;
  /** Header values supplied or retained by the caller. */
  values?: PurchaseOrderHeaderValues;
  /** Authorized vendor choices; the server must revalidate eligibility. */
  vendors: readonly { value: string; label: string; disabled?: boolean }[];
  /** Field-name overrides for an existing endpoint. */
  names?: Partial<Record<keyof PurchaseOrderHeaderValues, string>>;
  /** Canonical field errors returned by the server. */
  errors?: Partial<Record<keyof PurchaseOrderHeaderValues, string>>;
  /** Form-level server error or uncertain-outcome message. */
  message?: string;
  /** Caller-owned identity, authorization and retry fields. */
  hiddenFields?: readonly { name: string; value: string }[];
  /** Presentation only; server authorization remains mandatory. */
  readonly?: boolean;
  /** Disable the form while transport is in progress. */
  busy?: boolean;
  /** Native submitter identity. */
  intent?: { name: string; value: string };
  /** Localized title and submit label overrides. */
  labels?: { title?: string; submit?: string };
  /** Native encoding/ID and caller-owned Svelte attachments. */
  formAttributes?: QuoteFormAttributes;
  /** Optional transport enhancement; preventDefault belongs to the caller. */
  onsubmit?: HTMLFormAttributes['onsubmit'];
}
let {
  action,
  values = {},
  vendors,
  names = {},
  errors = {},
  message,
  hiddenFields = [],
  readonly = false,
  busy = false,
  intent = { name: 'intent', value: 'saveHeader' },
  labels = {},
  formAttributes = {},
  onsubmit,
}: Props = $props();
const { t } = useI18n();
const title = $derived(labels.title ?? t(P['commerce.purchase.header']));
const textFields = [
  { key: 'reference', label: 'commerce.purchase.reference', multiline: false },
  {
    key: 'expectedDate',
    label: 'commerce.purchase.expected_date',
    multiline: false,
  },
  { key: 'shipTo', label: 'commerce.purchase.ship_to', multiline: true },
  { key: 'notes', label: 'commerce.purchase.notes', multiline: true },
] as const;
</script>

<section aria-label={title} data-smrt-component="PurchaseOrderHeaderForm">
  <h2>{title}</h2>
  {#if message}<p role="alert">{message}</p>{/if}
  <Form {...formAttributes} {action} method="post" {onsubmit} preventDefault={false}>
    {#each hiddenFields as field}<Input type="hidden" name={field.name} value={field.value} />{/each}
    <fieldset disabled={readonly || busy}>
      <legend>{title}</legend>
      <FormGroup label={t(P['commerce.purchase.vendor'])} error={errors.vendorId}>
        <Select name={names.vendorId ?? 'vendorId'} value={values.vendorId ?? ''} density="touch">
          <option value="">{t(P['commerce.purchase.vendor_prompt'])}</option>
          {#if values.vendorId && !vendors.some(vendor => vendor.value === values.vendorId)}
            <option value={values.vendorId}>{t(P['commerce.purchase.vendor_unavailable'], { id: values.vendorId })}</option>
          {/if}
          {#each vendors as vendor}
            <option value={vendor.value} disabled={vendor.disabled && vendor.value !== values.vendorId}>
              {vendor.disabled ? t(P['commerce.purchase.vendor_unavailable'], { id: vendor.label }) : vendor.label}
            </option>
          {/each}
        </Select>
      </FormGroup>
      {#each textFields as field}
        <FormGroup label={t(P[field.label])} error={errors[field.key]}>
          {#if field.multiline}
            <Textarea name={names[field.key] ?? field.key} value={values[field.key] ?? ''} />
          {:else}
            <Input name={names[field.key] ?? field.key} value={values[field.key] ?? ''} density="touch" />
          {/if}
        </FormGroup>
      {/each}
      {#if !readonly}<Button type="submit" name={intent.name} value={intent.value} density="touch">{labels.submit ?? t(P['commerce.purchase.save_header'])}</Button>{/if}
    </fieldset>
  </Form>
</section>
