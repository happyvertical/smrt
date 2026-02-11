<script lang="ts">
interface Props {
  trend: 'up' | 'down' | 'flat';
  percent: number;
}

const { trend, percent }: Props = $props();

const arrow = $derived(
  trend === 'up' ? '\u2191' : trend === 'down' ? '\u2193' : '\u2192',
);
</script>

<span class="trend-badge" class:up={trend === 'up'} class:down={trend === 'down'} class:flat={trend === 'flat'}>
	<span class="trend-arrow">{arrow}</span>
	<span class="trend-percent">{Math.abs(percent)}%</span>
</span>

<style>
	.trend-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 600;
		line-height: 1;
	}

	.trend-badge.up {
		background: var(--color-success-bg, #dcfce7);
		color: var(--color-success-text, #166534);
	}

	.trend-badge.down {
		background: var(--color-error-bg, #fee2e2);
		color: var(--color-error-text, #991b1b);
	}

	.trend-badge.flat {
		background: var(--color-neutral-bg, #f3f4f6);
		color: var(--color-neutral-text, #4b5563);
	}

	.trend-arrow {
		font-size: 0.875rem;
	}
</style>
