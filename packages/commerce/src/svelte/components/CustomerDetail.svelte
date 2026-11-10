<script lang="ts">
import { StatusBadge } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { PageHeader } from '@happyvertical/smrt-ui/layout';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
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
  /** Omits the built-in page header (title, subtitle, and its create/edit action) for hosts that frame the page themselves. */
  headless?: boolean;
  /** Replaces the built-in page header; not rendered when `headless` is set. */
  header?: Snippet;
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
  headless = false,
  header,
}: Props = $props();

const { t } = useI18n();
const singular = $derived(
  labels.singular ?? t(M['commerce.customer.singular']),
);
const plural = $derived(labels.plural ?? t(M['commerce.customer.plural']));
const notRecorded = $derived(t(M['commerce.party.not_recorded']));
const amountUnavailable = $derived(t(M['commerce.party.amount_unavailable']));
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

function identityKindLabel(value: string | undefined): string {
  if (value === 'business') return t(M['commerce.party.identity_business']);
  if (value === 'person') return t(M['commerce.party.identity_person']);
  return value || notRecorded;
}

function creditLimit(amountMinor: number): string {
  try {
    return formatPartyMinorUnits(
      amountMinor,
      currency,
      minorUnitExponent,
      locale,
    );
  } catch (error) {
    if (error instanceof RangeError) return amountUnavailable;
    throw error;
  }
}
</script>

<section class="smrt-customer-detail__root" data-smrt-component="CustomerDetail">
  {#if backHref}<Button href={backHref} variant="ghost">{t(M['commerce.party.back_to'], { plural })}</Button>{/if}
  {#if header && !headless}
    {@render header()}
  {:else if !headless}
    <PageHeader title={customer.profile.name} subtitle={customer.profile.description ?? t(M['commerce.customer.details'])}>
      {#snippet actions()}
        {#if canEdit && editHref}<Button href={editHref}>{labels.edit ?? (labels.singular ? t(M['commerce.party.edit_named'], { singular }) : t(M['commerce.customer.edit']))}</Button>{/if}
      {/snippet}
    </PageHeader>
  {/if}

  <div class="smrt-customer-detail__summary-grid" data-smrt-part="summary">
    <Card padding="md">
      <h2>{t(M['commerce.party.identity'])}</h2>
      <dl>
        <dt>{t(M['commerce.party.type'])}</dt><dd>{identityKindLabel(customer.profile.identityKind)}</dd>
        <dt>{t(M['commerce.party.status'])}</dt><dd><StatusBadge status={customer.status} label={statusLabel(customer.status)} /></dd>
        <dt>{t(M['commerce.customer.type'])}</dt><dd>{customerTypeLabel(customer.customerType)}</dd>
        <dt>{t(M['commerce.party.email'])}</dt><dd>{#if customer.profile.email}<a href={`mailto:${customer.profile.email}`}>{customer.profile.email}</a>{:else}{notRecorded}{/if}</dd>
      </dl>
    </Card>
    <Card padding="md">
      <h2>{t(M['commerce.party.commercial_terms'])}</h2>
      <dl>
        <dt>{t(M['commerce.customer.credit_limit'])}</dt><dd>{customer.creditLimitMinor === undefined ? notRecorded : creditLimit(customer.creditLimitMinor)}</dd>
        <dt>{t(M['commerce.party.payment_terms'])}</dt><dd>{customer.paymentTerms || notRecorded}</dd>
        <dt>{t(M['commerce.customer.tax_exempt'])}</dt><dd>{customer.taxExempt ? t(M['commerce.party.yes']) : t(M['commerce.party.no'])}</dd>
      </dl>
    </Card>
  </div>

  <div class="smrt-customer-detail__summary-grid" data-smrt-part="summary">
    <Card padding="md"><h2>{t(M['commerce.party.shipping_address'])}</h2><p class="smrt-customer-detail__address" data-smrt-part="content">{shippingAddress || notRecorded}</p></Card>
    <Card padding="md"><h2>{t(M['commerce.party.billing_address'])}</h2><p class="smrt-customer-detail__address" data-smrt-part="content">{billingAddress || notRecorded}</p></Card>
  </div>

  <PartyContactFields contacts={customer.contacts ?? []} labels={contactLabels} readOnly />
  {#if customer.notes}<Card padding="md"><h2>{t(M['commerce.party.notes'])}</h2><p class="smrt-customer-detail__notes" data-smrt-part="content">{customer.notes}</p></Card>{/if}
  {@render extension?.(customer)}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-customer-detail__root {
    display: grid;
    gap: var(--smrt-spacing-5);
    max-inline-size: 64rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }
  .smrt-customer-detail__summary-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--smrt-spacing-4);
  }
  h2 {
    margin: 0 0 var(--smrt-spacing-4);
  }
  dl {
    display: grid;
    grid-template-columns: minmax(7rem, max-content) minmax(0, 1fr);
    gap: var(--smrt-spacing-2) var(--smrt-spacing-4);
    margin: 0;
  }
  dd {
    margin: 0;
  }
  .smrt-customer-detail__address, .smrt-customer-detail__notes {
    margin: 0;
    white-space: pre-wrap;
  }
  @media (max-width: 42rem) {
    .smrt-customer-detail__summary-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    dl {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--smrt-spacing-1);
    }
    dd {
      margin-block-end: var(--smrt-spacing-2);
    }
  }
}

@layer smrt.theme {
  h2 {
    font: var(--smrt-typography-title-medium-font);
    color: var(--smrt-color-on-surface);
  }
  dt {
    color: var(--smrt-color-on-surface-variant);
  }
  a {
    color: var(--smrt-color-primary);
  }
}

</style>
