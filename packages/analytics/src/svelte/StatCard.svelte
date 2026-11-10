<script lang="ts">
import TrendBadge from './TrendBadge.svelte';

interface Props {
  /** Descriptive label displayed at the top of the card. */
  label: string;
  /** Numeric value or text displayed prominently. */
  value: number | string;
  /** Direction indicator: up, down, or flat growth. */
  trend?: 'up' | 'down' | 'flat';
  /** Percent change; null is a zero baseline shown as 'new', undefined hides the badge. */
  trendPercent?: number | null;
  /** Secondary text displayed below the value. */
  subtitle?: string;
}

const { label, value, trend, trendPercent, subtitle }: Props = $props();
</script>

<div class="smrt-stat-card__root" data-smrt-component="StatCard">
	<div class="smrt-stat-card__label" data-smrt-part="label">{label}</div>
	<div class="smrt-stat-card__row" data-smrt-part="row">
		<div class="smrt-stat-card__value" data-smrt-part="value">{value}</div>
		{#if trend && trendPercent !== undefined}
			<TrendBadge {trend} percent={trendPercent} />
		{/if}
	</div>
	{#if subtitle}
		<div class="smrt-stat-card__subtitle" data-smrt-part="description">{subtitle}</div>
	{/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-stat-card__root {
    padding: 1rem;
  }
  .smrt-stat-card__label {
    margin-bottom: 0.25rem;
  }
  .smrt-stat-card__row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .smrt-stat-card__subtitle {
    margin-top: 0.25rem;
  }
}

@layer smrt.theme {
  .smrt-stat-card__root {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: 0.5rem;
  }
  .smrt-stat-card__label {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.05em);
  }
  .smrt-stat-card__value {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface);
    line-height: var(--smrt-typography-headline-small-line-height, 1.2);
  }
  .smrt-stat-card__subtitle {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
