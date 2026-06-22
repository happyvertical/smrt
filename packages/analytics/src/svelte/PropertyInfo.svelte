<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from './i18n.js';
import PropertyStatusBadge from './PropertyStatusBadge.svelte';

const { t } = useI18n();

interface Props {
  propertyId: string | null;
  measurementId: string | null;
  provider: string | null;
  status: 'active' | 'inactive' | 'pending';
  lastSyncAt: string | null;
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

<div class="property-info">
	<div class="property-header">
		<h3>{t(M['analytics.property_info.title'])}</h3>
		<PropertyStatusBadge {status} />
	</div>

	{#if propertyId}
		<dl class="property-details">
			<div class="detail-row">
				<dt>Provider</dt>
				<dd>{providerLabel}</dd>
			</div>
			{#if measurementId}
				<div class="detail-row">
					<dt>{t(M['analytics.property_info.measurement_id'])}</dt>
					<dd><code>{measurementId}</code></dd>
				</div>
			{/if}
			{#if siteDomain}
				<div class="detail-row">
					<dt>Domain</dt>
					<dd>{siteDomain}</dd>
				</div>
			{/if}
			<div class="detail-row">
				<dt>{t(M['analytics.property_info.last_synced'])}</dt>
				<dd>{lastSyncFormatted}</dd>
			</div>
		</dl>
	{:else}
		<p class="no-property">{t(M['analytics.property_info.no_property'])}</p>
	{/if}
</div>

<style>
	.property-info {
		padding: 1rem;
		background: var(--color-surface, #fff);
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 0.5rem;
	}

	.property-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.75rem;
	}

	.property-header h3 {
		margin: 0;
		font-size: var(--smrt-typography-title-medium-size, 1rem);
		font-weight: var(--smrt-typography-weight-semibold, 600);
	}

	.property-details {
		margin: 0;
	}

	.detail-row {
		display: flex;
		justify-content: space-between;
		padding: 0.375rem 0;
		border-bottom: 1px solid var(--color-border-light, #f3f4f6);
	}

	.detail-row:last-child {
		border-bottom: none;
	}

	dt {
		font-size: var(--smrt-typography-label-large-size, 0.8125rem);
		color: var(--color-text-secondary, #6b7280);
	}

	dd {
		margin: 0;
		font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
		font-weight: var(--smrt-typography-weight-medium, 500);
		color: var(--color-text-primary, #111827);
	}

	code {
		font-family: var(--smrt-font-family-mono, monospace);
		font-size: var(--smrt-typography-body-small-size, 0.75rem);
		padding: 0.125rem 0.25rem;
		background: var(--color-neutral-bg, #f3f4f6);
		border-radius: 0.25rem;
	}

	.no-property {
		margin: 0;
		color: var(--color-text-secondary, #6b7280);
		font-size: var(--smrt-typography-body-medium-size, 0.875rem);
	}
</style>
