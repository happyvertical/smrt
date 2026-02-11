<script lang="ts">
import type { PropertyStatsWithTrend } from '../types/index.js';
import StatCard from './StatCard.svelte';

interface Props {
  stats: PropertyStatsWithTrend | null;
}

const { stats }: Props = $props();
</script>

{#if stats}
	<div class="analytics-summary">
		<StatCard
			label="Pageviews Today"
			value={stats.todayPageviews.toLocaleString()}
			trend={stats.trend}
			trendPercent={stats.trendPercent}
			subtitle="vs. yesterday ({stats.yesterdayPageviews.toLocaleString()})"
		/>
		<StatCard
			label="Users Today"
			value={stats.todayUsers.toLocaleString()}
			subtitle="unique visitors"
		/>
		<StatCard
			label="Yesterday Pageviews"
			value={stats.yesterdayPageviews.toLocaleString()}
		/>
		<StatCard
			label="Yesterday Users"
			value={stats.yesterdayUsers.toLocaleString()}
		/>
	</div>
{:else}
	<div class="analytics-empty">
		<p>No analytics data available yet.</p>
	</div>
{/if}

<style>
	.analytics-summary {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 1rem;
	}

	.analytics-empty {
		text-align: center;
		padding: 2rem;
		color: var(--color-text-secondary, #6b7280);
		background: var(--color-neutral-bg, #f9fafb);
		border-radius: 0.5rem;
	}

	.analytics-empty p {
		margin: 0;
	}
</style>
