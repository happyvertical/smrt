<script lang="ts">
interface Props {
  trend: 'up' | 'down' | 'flat';
  // `null` means growth from a zero baseline \u2014 no finite percentage exists, so
  // the badge shows "new" instead of a misleading 0%.
  percent: number | null;
}

const { trend, percent }: Props = $props();

const arrow = $derived(
  trend === 'up' ? '\u2191' : trend === 'down' ? '\u2193' : '\u2192',
);

const display = $derived(percent === null ? 'new' : `${Math.abs(percent)}%`);
</script>

<span class="trend-badge" class:up={trend === 'up'} class:down={trend === 'down'} class:flat={trend === 'flat'}>
	<span class="trend-arrow" aria-hidden="true">{arrow}</span>
	<span class="trend-percent">{display}</span>
</span>

<style>
	.trend-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.125rem 0.5rem;
		border-radius: var(--smrt-radius-full, 9999px);
		font-size: var(--smrt-typography-label-medium-size, 0.75rem);
		font-weight: var(--smrt-typography-weight-semibold, 600);
		line-height: 1;
	}

	.trend-badge.up {
		background: var(--smrt-color-success-container);
		color: var(--smrt-color-on-success-container);
	}

	.trend-badge.down {
		background: var(--smrt-color-error-container);
		color: var(--smrt-color-on-error-container);
	}

	.trend-badge.flat {
		background: var(--smrt-color-surface-container);
		color: var(--smrt-color-on-surface-variant);
	}

	.trend-arrow {
		font-size: var(--smrt-typography-label-large-size, 0.875rem);
	}
</style>
