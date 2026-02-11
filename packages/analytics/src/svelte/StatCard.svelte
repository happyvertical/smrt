<script lang="ts">
import TrendBadge from './TrendBadge.svelte';

interface Props {
  label: string;
  value: number | string;
  trend?: 'up' | 'down' | 'flat';
  trendPercent?: number;
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
		background: var(--color-surface, #fff);
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 0.5rem;
	}

	.stat-label {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text-secondary, #6b7280);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 0.25rem;
	}

	.stat-row {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.stat-value {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--color-text-primary, #111827);
		line-height: 1.2;
	}

	.stat-subtitle {
		font-size: 0.75rem;
		color: var(--color-text-tertiary, #9ca3af);
		margin-top: 0.25rem;
	}
</style>
