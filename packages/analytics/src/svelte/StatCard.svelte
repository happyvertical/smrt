<script lang="ts">
import TrendBadge from './TrendBadge.svelte';

interface Props {
  label: string;
  value: number | string;
  trend?: 'up' | 'down' | 'flat';
  // `null` is a valid value (growth from a zero baseline — TrendBadge shows
  // "new"); only `undefined` suppresses the trend badge.
  trendPercent?: number | null;
  subtitle?: string;
}

const { label, value, trend, trendPercent, subtitle }: Props = $props();
</script>

<div class="stat-card">
	<div class="stat-label">{label}</div>
	<div class="stat-row">
		<div class="stat-value">{value}</div>
		{#if trend && trendPercent !== undefined}
			<TrendBadge {trend} percent={trendPercent} />
		{/if}
	</div>
	{#if subtitle}
		<div class="stat-subtitle">{subtitle}</div>
	{/if}
</div>

<style>
	.stat-card {
		padding: 1rem;
		background: var(--smrt-color-surface);
		border: 1px solid var(--smrt-color-outline-variant);
		border-radius: 0.5rem;
	}

	.stat-label {
		font-size: var(--smrt-typography-label-medium-size, 0.75rem);
		font-weight: var(--smrt-typography-weight-medium, 500);
		color: var(--smrt-color-on-surface-variant);
		text-transform: uppercase;
		letter-spacing: var(--smrt-typography-label-medium-tracking, 0.05em);
		margin-bottom: 0.25rem;
	}

	.stat-row {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.stat-value {
		font-size: var(--smrt-typography-headline-small-size, 1.5rem);
		font-weight: var(--smrt-typography-weight-bold, 700);
		color: var(--smrt-color-on-surface);
		line-height: var(--smrt-typography-headline-small-line-height, 1.2);
	}

	.stat-subtitle {
		font-size: var(--smrt-typography-body-small-size, 0.75rem);
		color: var(--smrt-color-on-surface-variant);
		margin-top: 0.25rem;
	}
</style>
