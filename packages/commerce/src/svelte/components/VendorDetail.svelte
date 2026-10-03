<script lang="ts">
import { StatusBadge } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { PageHeader } from '@happyvertical/smrt-ui/layout';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type {
  PartyContactLabels,
  PartyExtension,
  PartySurfaceLabels,
  VendorDisplayData,
} from '../party-types.js';
import { formatPartyMinorUnits } from '../party-types.js';
import PartyContactFields from './PartyContactFields.svelte';

/** Props for the vendor detail/summary surface. */
export interface Props {
  /** Vendor and Profile projection to render. */
  vendor: VendorDisplayData;
  /** Vendor terminology and action-label overrides. */
  labels?: PartySurfaceLabels;
  /** Contact terminology overrides. */
  contactLabels?: PartyContactLabels;
  /** Caller-owned URL back to the vendor directory. */
  backHref?: string;
  /** Caller-owned URL for editing this vendor. */
  editHref?: string;
  /** Controls whether the edit affordance is presented. */
  canEdit?: boolean;
  /** Currency exponent used only for minor-unit display conversion. */
  minorUnitExponent?: number;
  /** Locale used for currency display. */
  locale?: string;
  /** Consumer content rendered after the standard vendor sections. */
  extension?: PartyExtension<VendorDisplayData>;
}

const {
  vendor,
  labels = {},
  contactLabels,
  backHref,
  editHref,
  canEdit = false,
  minorUnitExponent = 2,
  locale = 'en',
  extension,
}: Props = $props();
const { t } = useI18n();
const notRecorded = $derived(t(M['commerce.party.not_recorded']));
</script>

<section class="party-detail">
  {#if backHref}<Button href={backHref} variant="ghost">{t(M['commerce.party.back_to'], { plural: labels.plural ?? t(M['commerce.vendor.plural']).toLowerCase() })}</Button>{/if}
  <PageHeader title={vendor.profile.name} subtitle={vendor.profile.description ?? t(M['commerce.vendor.details'])}>
    {#snippet actions()}
      {#if canEdit && editHref}<Button href={editHref}>{labels.edit ?? (labels.singular ? `Edit ${labels.singular}` : t(M['commerce.vendor.edit']))}</Button>{/if}
    {/snippet}
  </PageHeader>

  <div class="summary-grid">
    <Card padding="md">
      <h2>Identity</h2>
      <dl>
        <dt>Type</dt><dd>{vendor.profile.identityKind === 'person' ? 'Person' : 'Business'}</dd>
        <dt>Status</dt><dd><StatusBadge status={vendor.status} label={vendor.status} /></dd>
        <dt>Email</dt><dd>{#if vendor.profile.email}<a href={`mailto:${vendor.profile.email}`}>{vendor.profile.email}</a>{:else}{notRecorded}{/if}</dd>
      </dl>
    </Card>
    <Card padding="md">
      <h2>{t(M['commerce.party.commercial_terms'])}</h2>
      <dl>
        <dt>{t(M['commerce.vendor.lead_time'])}</dt><dd>{vendor.leadTimeDays === undefined ? notRecorded : `${vendor.leadTimeDays} days`}</dd>
        <dt>{t(M['commerce.vendor.minimum_order'])}</dt><dd>{vendor.minimumOrderMinor === undefined ? notRecorded : formatPartyMinorUnits(vendor.minimumOrderMinor, vendor.currency ?? 'USD', minorUnitExponent, locale)}</dd>
        <dt>{t(M['commerce.party.payment_terms'])}</dt><dd>{vendor.paymentTerms || notRecorded}</dd>
        <dt>{t(M['commerce.vendor.currency'])}</dt><dd>{vendor.currency || notRecorded}</dd>
      </dl>
    </Card>
  </div>

  <Card padding="md">
    <h2>{t(M['commerce.vendor.default_order_contact'])}</h2>
    <dl>
      <dt>Email</dt><dd>{#if vendor.defaultContactEmail}<a href={`mailto:${vendor.defaultContactEmail}`}>{vendor.defaultContactEmail}</a>{:else}{notRecorded}{/if}</dd>
      <dt>Phone</dt><dd>{#if vendor.defaultContactPhone}<a href={`tel:${vendor.defaultContactPhone}`}>{vendor.defaultContactPhone}</a>{:else}{notRecorded}{/if}</dd>
    </dl>
  </Card>

  <PartyContactFields contacts={vendor.contacts ?? []} labels={contactLabels} readOnly />
  {#if vendor.notes}<Card padding="md"><h2>Notes</h2><p class="notes">{vendor.notes}</p></Card>{/if}
  {@render extension?.(vendor)}
</section>

<style>
  .party-detail { display: grid; gap: var(--smrt-spacing-5); max-inline-size: 64rem; min-inline-size: 0; overflow-wrap: anywhere; }
  .summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--smrt-spacing-4); }
  h2 { margin: 0 0 var(--smrt-spacing-4); font: var(--smrt-typography-title-medium-font); color: var(--smrt-color-on-surface); }
  dl { display: grid; grid-template-columns: minmax(7rem, max-content) minmax(0, 1fr); gap: var(--smrt-spacing-2) var(--smrt-spacing-4); margin: 0; }
  dt { color: var(--smrt-color-on-surface-variant); }
  dd { margin: 0; }
  a { color: var(--smrt-color-primary); }
  .notes { margin: 0; white-space: pre-wrap; }
  @media (max-width: 42rem) { .summary-grid { grid-template-columns: minmax(0, 1fr); } dl { grid-template-columns: minmax(0, 1fr); gap: var(--smrt-spacing-1); } dd { margin-block-end: var(--smrt-spacing-2); } }
</style>
