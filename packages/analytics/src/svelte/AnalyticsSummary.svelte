<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { PropertyStatsWithTrend } from '../index.js';
import { M } from './i18n.js';
import StatCard from './StatCard.svelte';

const { t } = useI18n();

interface Props {
  /** Analytics data including pageview and user counts with trend comparison. */
  stats: PropertyStatsWithTrend | null;
}

const { stats }: Props = $props();
</script>

{#if stats}
	<div class="smrt-analytics-summary__root" data-smrt-component="AnalyticsSummary">
		<StatCard
			label="Pageviews Today"
			value={stats.todayPageviews.toLocaleString()}
			trend={stats.trend}
			trendPercent={stats.trendPercent}
			subtitle={`vs. yesterday (${stats.yesterdayPageviews.toLocaleString()})`}
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
	<div class="smrt-analytics-summary__empty" data-smrt-component="AnalyticsSummary" >
		<p>{t(M['analytics.analytics_summary.empty'])}</p>
	</div>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-analytics-summary__root {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 1rem;
  }
  .smrt-analytics-summary__empty {
    padding: 2rem;
  }
  .smrt-analytics-summary__empty p {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-analytics-summary__empty {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
    background: var(--smrt-color-surface-container);
    border-radius: 0.5rem;
  }
}

</style>
