<script lang="ts">
import type { CodeSelectOption } from '@happyvertical/smrt-ui/forms';
import {
  CurrencySelect,
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
  PartyContactLabels,
  PartyExtension,
  PartyFormErrors,
  PartyFormTransport,
  PartySurfaceLabels,
  VendorFieldNames,
  VendorFormValues,
} from '../party-types.js';
import { DEFAULT_VENDOR_FIELD_NAMES } from '../party-types.js';
import PartyContactFields from './PartyContactFields.svelte';

/** Props for the native, SSR-safe vendor create/edit form. */
export interface Props {
  /** Selects create or edit copy and identity-lock defaults. */
  mode?: 'create' | 'edit';
  /** Exact vendor values to render, including server-retained strings. */
  values?: VendorFormValues;
  /** Caller-owned native form action, method, tokens, and submitter intents. */
  transport?: PartyFormTransport;
  /** HTML field-name overrides used to preserve an existing payload contract. */
  fieldNames?: Partial<VendorFieldNames>;
  /** Form, field, and contact errors returned by the server. */
  errors?: PartyFormErrors;
  /** Vendor terminology and action-label overrides. */
  labels?: PartySurfaceLabels;
  /** Contact terminology overrides. */
  contactLabels?: PartyContactLabels;
  /** Caller-restricted currency choices; omitted uses the shared ISO defaults. */
  currencyOptions?: readonly CodeSelectOption[];
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
  extension?: PartyExtension<VendorFormValues>;
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
  currencyOptions,
  readOnly = false,
  canSubmit = true,
  canAddContact = true,
  canRemoveContact = true,
  lockIdentityKind = mode === 'edit',
  cancelHref,
  extension,
  actions,
}: Props = $props();

const i18n = useI18n();
const { t } = i18n;
const singular = $derived(labels.singular ?? t(M['commerce.vendor.singular']));
const names = $derived({ ...DEFAULT_VENDOR_FIELD_NAMES, ...fieldNames });
const intentName = $derived(transport.intentName ?? 'intent');
const errorList = $derived(
  Object.entries(errors.fields ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([field, message]) => ({
      controlId:
        field in names ? names[field as keyof VendorFieldNames] : field,
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
        {labels.save ?? (labels.singular ? t(M[mode === 'create' ? 'commerce.party.add_named' : 'commerce.party.save_named'], { singular: labels.singular }) : t(M[mode === 'create' ? 'commerce.vendor.add' : 'commerce.vendor.save']))}
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
    </div>
    <FormGroup label={t(M['commerce.party.description'])} error={errors.fields?.description}>
      <Textarea name={names.description} value={values.description ?? ''} rows={3} maxlength={1000} readonly={readOnly} />
    </FormGroup>
  </fieldset>

  <fieldset class="form-section">
    <legend>{t(M['commerce.party.commercial_terms'])}</legend>
    <div class="field-grid">
      <FormGroup label={t(M['commerce.vendor.lead_time'])} error={errors.fields?.leadTimeDays}>
        <Input name={names.leadTimeDays} inputmode="numeric" value={values.leadTimeDays ?? ''} readonly={readOnly} />
      </FormGroup>
      <FormGroup label={t(M['commerce.vendor.minimum_order'])} hint={t(M['commerce.vendor.minimum_order_hint'])} error={errors.fields?.minimumOrder}>
        <Input name={names.minimumOrder} inputmode="decimal" value={values.minimumOrder ?? ''} readonly={readOnly} />
      </FormGroup>
      <FormGroup label={t(M['commerce.vendor.currency'])} error={errors.fields?.currency}>
        <CurrencySelect name={names.currency} value={values.currency ?? 'USD'} options={currencyOptions} locale={i18n.locale} readOnly={readOnly} />
      </FormGroup>
      <FormGroup label={t(M['commerce.party.payment_terms'])} error={errors.fields?.paymentTerms}>
        <Input name={names.paymentTerms} value={values.paymentTerms ?? ''} maxlength={120} readonly={readOnly} />
      </FormGroup>
      <FormGroup label={t(M['commerce.vendor.default_contact_email'])} error={errors.fields?.defaultContactEmail}>
        <Input name={names.defaultContactEmail} type="email" value={values.defaultContactEmail ?? ''} maxlength={320} readonly={readOnly} />
      </FormGroup>
      <FormGroup label={t(M['commerce.vendor.default_contact_phone'])} error={errors.fields?.defaultContactPhone}>
        <Input name={names.defaultContactPhone} type="tel" value={values.defaultContactPhone ?? ''} maxlength={80} readonly={readOnly} />
      </FormGroup>
    </div>
    <FormGroup label={t(M['commerce.party.internal_notes'])} error={errors.fields?.notes}>
      <Textarea name={names.notes} value={values.notes ?? ''} rows={4} maxlength={4000} readonly={readOnly} />
    </FormGroup>
  </fieldset>

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
        {labels.save ?? (labels.singular ? t(M[mode === 'create' ? 'commerce.party.add_named' : 'commerce.party.save_named'], { singular: labels.singular }) : t(M[mode === 'create' ? 'commerce.vendor.add' : 'commerce.vendor.save']))}
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
  .field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 var(--smrt-spacing-4); }
  @media (max-width: 42rem) { .field-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
