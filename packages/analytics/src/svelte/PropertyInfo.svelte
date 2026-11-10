<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from './i18n.js';
import PropertyStatusBadge from './PropertyStatusBadge.svelte';

const { t } = useI18n();

interface Props {
  /** Identifier for the analytics property; empty state is shown if null. */
  propertyId: string | null;
  /** Tracking ID or measurement identifier for the analytics platform. */
  measurementId: string | null;
  /** Analytics provider type (e.g., 'ga4', 'plausible', 'matomo'). */
  provider: string | null;
  /** Current status of the property connection. */
  status: 'active' | 'inactive' | 'pending';
  /** ISO timestamp of the most recent data synchronization. */
  lastSyncAt: string | null;
  /** Website domain associated with the analytics property. */
  siteDomain?: string;
}

const {
  propertyId,
  measurementId,
  provider,
  status,
  lastSyncAt,
  siteDomain,
}: Props = $props();

const PROVIDER_LABELS = new Map<string, string>([
  ['ga4', 'Google Analytics 4'],
  ['plausible', 'Plausible'],
  ['matomo', 'Matomo'],
]);

const providerLabel = $derived(
  provider ? (PROVIDER_LABELS.get(provider) ?? provider) : 'Unknown',
);

const lastSyncFormatted = $derived.by(() => {
  if (!lastSyncAt) return 'Never';
  const parsed = new Date(lastSyncAt);
  if (Number.isNaN(parsed.getTime())) return 'Never';
  return parsed.toLocaleString();
});
</script>

<div class="smrt-property-info__root" data-smrt-component="PropertyInfo">
	<div class="smrt-property-info__header" data-smrt-part="header">
		<h3>{t(M['analytics.property_info.title'])}</h3>
		<PropertyStatusBadge {status} />
	</div>

	{#if propertyId}
		<dl class="smrt-property-info__details" data-smrt-part="details">
			<div class="smrt-property-info__row" data-smrt-part="row">
				<dt>Provider</dt>
				<dd>{providerLabel}</dd>
			</div>
			{#if measurementId}
				<div class="smrt-property-info__row" data-smrt-part="row">
					<dt>{t(M['analytics.property_info.measurement_id'])}</dt>
					<dd><code>{measurementId}</code></dd>
				</div>
			{/if}
			{#if siteDomain}
				<div class="smrt-property-info__row" data-smrt-part="row">
					<dt>Domain</dt>
					<dd>{siteDomain}</dd>
				</div>
			{/if}
			<div class="smrt-property-info__row" data-smrt-part="row">
				<dt>{t(M['analytics.property_info.last_synced'])}</dt>
				<dd>{lastSyncFormatted}</dd>
			</div>
		</dl>
	{:else}
		<p class="smrt-property-info__empty" data-smrt-part="empty">{t(M['analytics.property_info.no_property'])}</p>
	{/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-property-info__root {
    padding: 1rem;
  }
  .smrt-property-info__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }
  .smrt-property-info__header h3 {
    margin: 0;
  }
  .smrt-property-info__details {
    margin: 0;
  }
  .smrt-property-info__row {
    display: flex;
    justify-content: space-between;
    padding: 0.375rem 0;
  }
  dd {
    margin: 0;
  }
  code {
    padding: 0.125rem 0.25rem;
  }
  .smrt-property-info__empty {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-property-info__root {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: 0.5rem;
  }
  .smrt-property-info__header h3 {
    font-size: var(--smrt-typography-title-medium-size, 1rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-property-info__row {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-property-info__row:last-child {
    border-bottom: none;
  }
  dt {
    font-size: var(--smrt-typography-label-large-size, 0.8125rem);
    color: var(--smrt-color-on-surface-variant);
  }
  dd {
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }
  code {
    font-family: var(--smrt-font-family-mono, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    background: var(--smrt-color-surface-container);
    border-radius: 0.25rem;
  }
  .smrt-property-info__empty {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
}

</style>
