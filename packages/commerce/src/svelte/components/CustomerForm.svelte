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
import { M } from '../i18n.js';
import type {
  CustomerFieldNames,
  CustomerFormValues,
  PartyContactLabels,
  PartyExtension,
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
</script>

<Form
  class="party-form"
  action={transport.action}
  method={transport.method ?? 'post'}
  preventDefault={false}
  stagedReview={false}
>
  {#each Object.entries(transport.hiddenFields ?? {}) as [name, value]}
    <Input interaction={false} type="hidden" {name} {value} />
  {/each}
  {#if values.profileId}
    <Input interaction={false} type="hidden" name={names.profileId} value={values.profileId} />
  {/if}
  {#if !readOnly && canSubmit}
    <span class="native-default-submit" aria-hidden="true">
      <Button type="submit" name={intentName} value={transport.saveIntent ?? 'save'} tabindex={-1}>
        {labels.save ?? (labels.singular ? t(M[mode === 'create' ? 'commerce.party.add_named' : 'commerce.party.save_named'], { singular: labels.singular }) : t(M[mode === 'create' ? 'commerce.customer.add' : 'commerce.customer.save']))}
      </Button>
    </span>
  {/if}

  {#if errors.form}<p class="form-error" role="alert">{errors.form}</p>{/if}
  <ErrorSummary errors={errorList} />

  <fieldset class="form-section">
    <legend>{t(M['commerce.party.identity'])}</legend>
    {#if lockIdentityKind && values.identityKind}
      <p class="locked-value">{t(M['commerce.party.identity'])}: {values.identityKind === 'business' ? t(M['commerce.party.identity_business']) : t(M['commerce.party.identity_person'])}</p>
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
    <div class="field-grid">
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

  <fieldset class="form-section">
    <legend>{t(M['commerce.party.commercial_terms'])}</legend>
    <div class="field-grid">
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

  <div class="address-pair">
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
  :global(.party-form) { display: grid; gap: var(--smrt-spacing-5); min-inline-size: 0; padding-block-end: var(--smrt-spacing-8); }
  .native-default-submit { position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .form-error { margin: 0; padding: var(--smrt-spacing-4); border-inline-start: 4px solid var(--smrt-color-error); background: var(--smrt-color-error-container); color: var(--smrt-color-on-error-container); border-radius: var(--smrt-radius-small); }
  .form-section { min-inline-size: 0; margin: 0; padding: var(--smrt-spacing-4); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium); }
  legend { padding-inline: var(--smrt-spacing-2); font: var(--smrt-typography-title-medium-font); color: var(--smrt-color-on-surface); }
  .locked-value { color: var(--smrt-color-on-surface-variant); }
  .field-grid, .address-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 var(--smrt-spacing-4); }
  .address-pair { gap: var(--smrt-spacing-4); }
  @media (max-width: 42rem) { .field-grid, .address-pair { grid-template-columns: minmax(0, 1fr); } }
</style>
