<script lang="ts">
import { StatusBadge } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { PageHeader } from '@happyvertical/smrt-ui/layout';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type {
  CustomerDisplayData,
  PartyContactLabels,
  PartyExtension,
  PartySurfaceLabels,
} from '../party-types.js';
import { formatPartyAddress, formatPartyMinorUnits } from '../party-types.js';
import PartyContactFields from './PartyContactFields.svelte';

/** Props for the customer detail/summary surface. */
export interface Props {
  /** Customer and Profile projection to render. */
  customer: CustomerDisplayData;
  /** Customer terminology and action-label overrides. */
  labels?: PartySurfaceLabels;
  /** Contact terminology overrides. */
  contactLabels?: PartyContactLabels;
  /** Caller-owned URL back to the customer directory. */
  backHref?: string;
  /** Caller-owned URL for editing this customer. */
  editHref?: string;
  /** Controls whether the edit affordance is presented. */
  canEdit?: boolean;
  /** ISO currency code used to display the minor-unit credit limit. */
  currency?: string;
  /** Currency exponent used only for minor-unit display conversion. */
  minorUnitExponent?: number;
  /** Locale used for currency display. */
  locale?: string;
  /** Consumer content rendered after the standard customer sections. */
  extension?: PartyExtension<CustomerDisplayData>;
}

const {
  customer,
  labels = {},
  contactLabels,
  backHref,
  editHref,
  canEdit = false,
  currency = 'USD',
  minorUnitExponent = 2,
  locale = 'en',
  extension,
}: Props = $props();

const { t } = useI18n();
const singular = $derived(
  labels.singular ?? t(M['commerce.customer.singular']),
);
const plural = $derived(labels.plural ?? t(M['commerce.customer.plural']));
const notRecorded = $derived(t(M['commerce.party.not_recorded']));
const shippingAddress = $derived(
  formatPartyAddress(customer.defaultShippingAddress),
);
const billingAddress = $derived(
  formatPartyAddress(customer.defaultBillingAddress),
);

function statusLabel(value: string): string {
  if (value === 'active') return t(M['commerce.party.status_active']);
  if (value === 'inactive') return t(M['commerce.party.status_inactive']);
  if (value === 'suspended') return t(M['commerce.party.status_suspended']);
  return value;
}

function customerTypeLabel(value: string | undefined): string {
  if (value === 'dtc') return t(M['commerce.customer.type_dtc']);
  if (value === 'wholesale') return t(M['commerce.customer.type_wholesale']);
  if (value === 'retail') return t(M['commerce.customer.type_retail']);
  return value ?? notRecorded;
}
</script>

<section class="party-detail">
  {#if backHref}<Button href={backHref} variant="ghost">{t(M['commerce.party.back_to'], { plural })}</Button>{/if}
  <PageHeader title={customer.profile.name} subtitle={customer.profile.description ?? t(M['commerce.customer.details'])}>
    {#snippet actions()}
      {#if canEdit && editHref}<Button href={editHref}>{labels.edit ?? (labels.singular ? t(M['commerce.party.edit_named'], { singular }) : t(M['commerce.customer.edit']))}</Button>{/if}
    {/snippet}
  </PageHeader>

  <div class="summary-grid">
    <Card padding="md">
      <h2>{t(M['commerce.party.identity'])}</h2>
      <dl>
        <dt>{t(M['commerce.party.type'])}</dt><dd>{customer.profile.identityKind === 'person' ? t(M['commerce.party.identity_person']) : t(M['commerce.party.identity_business'])}</dd>
        <dt>{t(M['commerce.party.status'])}</dt><dd><StatusBadge status={customer.status} label={statusLabel(customer.status)} /></dd>
        <dt>{t(M['commerce.customer.type'])}</dt><dd>{customerTypeLabel(customer.customerType)}</dd>
        <dt>{t(M['commerce.party.email'])}</dt><dd>{#if customer.profile.email}<a href={`mailto:${customer.profile.email}`}>{customer.profile.email}</a>{:else}{notRecorded}{/if}</dd>
      </dl>
    </Card>
    <Card padding="md">
      <h2>{t(M['commerce.party.commercial_terms'])}</h2>
      <dl>
        <dt>{t(M['commerce.customer.credit_limit'])}</dt><dd>{customer.creditLimitMinor === undefined ? notRecorded : formatPartyMinorUnits(customer.creditLimitMinor, currency, minorUnitExponent, locale)}</dd>
        <dt>{t(M['commerce.party.payment_terms'])}</dt><dd>{customer.paymentTerms || notRecorded}</dd>
        <dt>{t(M['commerce.customer.tax_exempt'])}</dt><dd>{customer.taxExempt ? t(M['commerce.party.yes']) : t(M['commerce.party.no'])}</dd>
      </dl>
    </Card>
  </div>

  <div class="summary-grid">
    <Card padding="md"><h2>{t(M['commerce.party.shipping_address'])}</h2><p class="address">{shippingAddress || notRecorded}</p></Card>
    <Card padding="md"><h2>{t(M['commerce.party.billing_address'])}</h2><p class="address">{billingAddress || notRecorded}</p></Card>
  </div>

  <PartyContactFields contacts={customer.contacts ?? []} labels={contactLabels} readOnly />
  {#if customer.notes}<Card padding="md"><h2>{t(M['commerce.party.notes'])}</h2><p class="notes">{customer.notes}</p></Card>{/if}
  {@render extension?.(customer)}
</section>

<style>
  .party-detail { display: grid; gap: var(--smrt-spacing-5); max-inline-size: 64rem; min-inline-size: 0; overflow-wrap: anywhere; }
  .summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--smrt-spacing-4); }
  h2 { margin: 0 0 var(--smrt-spacing-4); font: var(--smrt-typography-title-medium-font); color: var(--smrt-color-on-surface); }
  dl { display: grid; grid-template-columns: minmax(7rem, max-content) minmax(0, 1fr); gap: var(--smrt-spacing-2) var(--smrt-spacing-4); margin: 0; }
  dt { color: var(--smrt-color-on-surface-variant); }
  dd { margin: 0; }
  a { color: var(--smrt-color-primary); }
  .address, .notes { margin: 0; white-space: pre-wrap; }
  @media (max-width: 42rem) { .summary-grid { grid-template-columns: minmax(0, 1fr); } dl { grid-template-columns: minmax(0, 1fr); gap: var(--smrt-spacing-1); } dd { margin-block-end: var(--smrt-spacing-2); } }
</style>
