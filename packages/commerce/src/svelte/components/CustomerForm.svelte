<script lang="ts">
import type { CodeSelectOption } from '@happyvertical/smrt-ui/forms';
import {
  Checkbox,
  ErrorSummary,
  Form,
  FormActionBar,
  FormGroup,
  Input,
  Select,
  Textarea,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import type { HTMLFormAttributes } from 'svelte/elements';
import { M } from '../i18n.js';
import type {
  CustomerFieldNames,
  CustomerFormValues,
  PartyContactLabels,
  PartyExtension,
  PartyFormEnhance,
  PartyFormErrors,
  PartyFormTransport,
  PartySurfaceLabels,
} from '../party-types.js';
import { DEFAULT_CUSTOMER_FIELD_NAMES } from '../party-types.js';
import PartyAddressFields from './PartyAddressFields.svelte';
import PartyContactFields from './PartyContactFields.svelte';

/** Props for the native, SSR-safe customer create/edit form. */
export interface Props {
  /** Selects create or edit copy and identity-lock defaults. */
  mode?: 'create' | 'edit';
  /** Exact customer values to render, including server-retained strings. */
  values?: CustomerFormValues;
  /** Caller-owned native form action, method, tokens, and submitter intents. */
  transport?: PartyFormTransport;
  /** HTML field-name overrides used to preserve an existing payload contract. */
  fieldNames?: Partial<CustomerFieldNames>;
  /** Form, field, and contact errors returned by the server. */
  errors?: PartyFormErrors;
  /** Customer terminology and action-label overrides. */
  labels?: PartySurfaceLabels;
  /** Contact terminology overrides. */
  contactLabels?: PartyContactLabels;
  /** Caller-restricted country choices for both addresses. */
  countryOptions?: readonly CodeSelectOption[];
  /** Caller-restricted region choices for both addresses. */
  provinceOptions?: readonly CodeSelectOption[];
  /** Renders values without mutation affordances. */
  readOnly?: boolean;
  /** Controls whether the save submitter is presented. */
  canSubmit?: boolean;
  /** Controls whether the native add-contact submitter is presented. */
  canAddContact?: boolean;
  /** Controls whether native remove-contact submitters are presented. */
  canRemoveContact?: boolean;
  /** Keeps an established Profile identity category from being converted. */
  lockIdentityKind?: boolean;
  /** Caller-owned URL used by the default cancel action. */
  cancelHref?: string;
  /** Consumer fields rendered before the action bar. */
  extension?: PartyExtension<CustomerFormValues>;
  /** Replaces the default cancel and save action bar. */
  actions?: Snippet;
  /** Progressive-enhancement hook for the native form element, such as SvelteKit's `enhance`. Needed when an `ssr = false` app must not answer a native post with its empty shell. */
  enhance?: PartyFormEnhance;
  /** Native submit handler. Submission stays native unless the handler calls `event.preventDefault()`. */
  onsubmit?: HTMLFormAttributes['onsubmit'];
}

const {
  mode = 'create',
  values = {},
  transport = {},
  fieldNames = {},
  errors = {},
  labels = {},
  contactLabels,
  countryOptions,
  provinceOptions,
  readOnly = false,
  canSubmit = true,
  canAddContact = true,
  canRemoveContact = true,
  lockIdentityKind = mode === 'edit',
  cancelHref,
  extension,
  actions,
  enhance,
  onsubmit,
}: Props = $props();

const { t } = useI18n();
const singular = $derived(
  labels.singular ?? t(M['commerce.customer.singular']),
);
const names = $derived({ ...DEFAULT_CUSTOMER_FIELD_NAMES, ...fieldNames });
const intentName = $derived(transport.intentName ?? 'intent');
const errorList = $derived(
  Object.entries(errors.fields ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([field, message]) => ({
      controlId:
        field in names ? names[field as keyof CustomerFieldNames] : field,
      message,
    })),
);

let formComponent = $state<ReturnType<typeof Form>>();

/** Returns the native form while mounted, or null before mount/after unmount. */
export function getFormElement(): HTMLFormElement | null {
  return formComponent?.getFormElement() ?? null;
}

function attachEnhance(form: HTMLFormElement) {
  const handle = enhance?.(form);
  return () => handle?.destroy?.();
}
</script>

<Form
  bind:this={formComponent}
  class="smrt-customer-form__form"
  action={transport.action}
  method={transport.method ?? 'post'}
  preventDefault={false}
  stagedReview={false}
  {onsubmit}
  {@attach attachEnhance}
>
  {#each Object.entries(transport.hiddenFields ?? {}) as [name, value]}
    <Input interaction={false} type="hidden" {name} {value} />
  {/each}
  {#if values.profileId}
    <Input interaction={false} type="hidden" name={names.profileId} value={values.profileId} />
  {/if}
  {#if !readOnly && canSubmit}
    <span class="smrt-customer-form__native-submit" aria-hidden="true" data-smrt-part="actions">
      <Button type="submit" name={intentName} value={transport.saveIntent ?? 'save'} tabindex={-1}>
        {labels.save ?? (labels.singular ? t(M[mode === 'create' ? 'commerce.party.add_named' : 'commerce.party.save_named'], { singular: labels.singular }) : t(M[mode === 'create' ? 'commerce.customer.add' : 'commerce.customer.save']))}
      </Button>
    </span>
  {/if}

  {#if errors.form}<p class="smrt-customer-form__error" role="alert" data-smrt-part="error">{errors.form}</p>{/if}
  <ErrorSummary errors={errorList} />

  <fieldset class="smrt-customer-form__section" data-smrt-part="group">
    <legend>{t(M['commerce.party.identity'])}</legend>
    {#if lockIdentityKind && values.identityKind}
      <p class="smrt-customer-form__locked-value" data-smrt-part="value">{t(M['commerce.party.identity'])}: {values.identityKind === 'business' ? t(M['commerce.party.identity_business']) : t(M['commerce.party.identity_person'])}</p>
      <Input interaction={false} type="hidden" name={names.identityKind} value={values.identityKind} />
    {:else}
      <FormGroup label={t(M['commerce.party.identity'])} required error={errors.fields?.identityKind}>
        <Select name={names.identityKind} value={values.identityKind ?? ''} required disabled={readOnly}>
          <option value="">{t(M['commerce.party.select_identity'])}</option>
          <option value="business">{t(M['commerce.party.identity_business'])}</option>
          <option value="person">{t(M['commerce.party.identity_person'])}</option>
        </Select>
      </FormGroup>
    {/if}
    <FormGroup label={t(M['commerce.party.name'], { singular })} required error={errors.fields?.name}>
      <Input name={names.name} value={values.name ?? ''} maxlength={160} required readonly={readOnly} />
    </FormGroup>
    <div class="smrt-customer-form__field-grid" data-smrt-part="group">
      <FormGroup label={t(M['commerce.party.profile_email'])} error={errors.fields?.email}>
        <Input name={names.email} type="email" value={values.email ?? ''} maxlength={320} readonly={readOnly} />
      </FormGroup>
      <FormGroup label={t(M['commerce.customer.type'])} error={errors.fields?.customerType}>
        <Select name={names.customerType} value={values.customerType ?? 'dtc'} disabled={readOnly}>
          {#if values.customerType && !['dtc', 'wholesale', 'retail'].includes(values.customerType)}
            <option value={values.customerType}>{values.customerType}</option>
          {/if}
          <option value="dtc">{t(M['commerce.customer.type_dtc'])}</option>
          <option value="wholesale">{t(M['commerce.customer.type_wholesale'])}</option>
          <option value="retail">{t(M['commerce.customer.type_retail'])}</option>
        </Select>
      </FormGroup>
    </div>
    <FormGroup label={t(M['commerce.party.description'])} error={errors.fields?.description}>
      <Textarea name={names.description} value={values.description ?? ''} rows={3} maxlength={1000} readonly={readOnly} />
    </FormGroup>
  </fieldset>

  <fieldset class="smrt-customer-form__section" data-smrt-part="group">
    <legend>{t(M['commerce.party.commercial_terms'])}</legend>
    <div class="smrt-customer-form__field-grid" data-smrt-part="group">
      <FormGroup label={t(M['commerce.party.status'])} error={errors.fields?.status}>
        <Select name={names.status} value={values.status ?? 'active'} disabled={readOnly}>
          {#if values.status && !['active', 'inactive', 'suspended'].includes(values.status)}
            <option value={values.status}>{values.status}</option>
          {/if}
          <option value="active">{t(M['commerce.party.status_active'])}</option>
          <option value="inactive">{t(M['commerce.party.status_inactive'])}</option>
          <option value="suspended">{t(M['commerce.party.status_suspended'])}</option>
        </Select>
      </FormGroup>
      <FormGroup label={t(M['commerce.customer.credit_limit'])} hint={t(M['commerce.customer.credit_limit_hint'])} error={errors.fields?.creditLimit}>
        <Input name={names.creditLimit} inputmode="decimal" value={values.creditLimit ?? ''} readonly={readOnly} />
      </FormGroup>
      <FormGroup label={t(M['commerce.party.payment_terms'])} error={errors.fields?.paymentTerms}>
        <Input name={names.paymentTerms} value={values.paymentTerms ?? ''} maxlength={120} readonly={readOnly} />
      </FormGroup>
    </div>
    <Checkbox name={names.taxExempt} value="true" checked={values.taxExempt ?? false} disabled={readOnly} label={t(M['commerce.customer.tax_exempt'])} />
    <FormGroup label={t(M['commerce.party.internal_notes'])} error={errors.fields?.notes}>
      <Textarea name={names.notes} value={values.notes ?? ''} rows={4} maxlength={4000} readonly={readOnly} />
    </FormGroup>
  </fieldset>

  <div class="smrt-customer-form__address-pair" data-smrt-part="group">
    <PartyAddressFields heading={t(M['commerce.party.shipping_address'])} value={values.shippingAddress} names={{ street1: names.shippingStreet1, street2: names.shippingStreet2, city: names.shippingCity, state: names.shippingState, postalCode: names.shippingPostalCode, country: names.shippingCountry }} errors={{ street1: errors.fields?.shippingStreet1, street2: errors.fields?.shippingStreet2, city: errors.fields?.shippingCity, state: errors.fields?.shippingState, postalCode: errors.fields?.shippingPostalCode, country: errors.fields?.shippingCountry }} {readOnly} {countryOptions} {provinceOptions} />
    <PartyAddressFields heading={t(M['commerce.party.billing_address'])} value={values.billingAddress} names={{ street1: names.billingStreet1, street2: names.billingStreet2, city: names.billingCity, state: names.billingState, postalCode: names.billingPostalCode, country: names.billingCountry }} errors={{ street1: errors.fields?.billingStreet1, street2: errors.fields?.billingStreet2, city: errors.fields?.billingCity, state: errors.fields?.billingState, postalCode: errors.fields?.billingPostalCode, country: errors.fields?.billingCountry }} {readOnly} {countryOptions} {provinceOptions} />
  </div>

  <PartyContactFields
    contacts={values.contacts ?? []}
    fieldNames={names}
    errors={errors.contacts}
    labels={contactLabels}
    readOnly={readOnly}
    canAdd={canAddContact}
    canRemove={canRemoveContact}
    {intentName}
    addIntent={transport.addContactIntent}
    removeIntent={transport.removeContactIntent}
  />

  {@render extension?.(values)}

  {#if actions}
    {@render actions()}
  {:else if !readOnly && canSubmit}
    <FormActionBar label={t(M['commerce.party.form_actions'], { singular })}>
      {#if cancelHref}<Button href={cancelHref} variant="ghost">{labels.cancel ?? t(M['commerce.party.cancel'])}</Button>{/if}
      <Button type="submit" name={intentName} value={transport.saveIntent ?? 'save'}>
        {labels.save ?? (labels.singular ? t(M[mode === 'create' ? 'commerce.party.add_named' : 'commerce.party.save_named'], { singular: labels.singular }) : t(M[mode === 'create' ? 'commerce.customer.add' : 'commerce.customer.save']))}
      </Button>
    </FormActionBar>
  {/if}
</Form>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  :global(.smrt-customer-form__form) {
    display: grid;
    gap: var(--smrt-spacing-5);
    min-inline-size: 0;
    padding-block-end: var(--smrt-spacing-8);
  }
  .smrt-customer-form__native-submit {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  .smrt-customer-form__error {
    margin: 0;
    padding: var(--smrt-spacing-4);
  }
  .smrt-customer-form__section {
    min-inline-size: 0;
    margin: 0;
    padding: var(--smrt-spacing-4);
  }
  legend {
    padding-inline: var(--smrt-spacing-2);
  }
  .smrt-customer-form__field-grid, .smrt-customer-form__address-pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 var(--smrt-spacing-4);
  }
  .smrt-customer-form__address-pair {
    gap: var(--smrt-spacing-4);
  }
  @media (max-width: 42rem) {
    .smrt-customer-form__field-grid, .smrt-customer-form__address-pair {
      grid-template-columns: minmax(0, 1fr);
    }
  }
}

@layer smrt.theme {
  .smrt-customer-form__native-submit {
    border: 0;
  }
  .smrt-customer-form__error {
    border-inline-start: 4px solid var(--smrt-color-error);
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
    border-radius: var(--smrt-radius-small);
  }
  .smrt-customer-form__section {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium);
  }
  legend {
    font: var(--smrt-typography-title-medium-font);
    color: var(--smrt-color-on-surface);
  }
  .smrt-customer-form__locked-value {
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
