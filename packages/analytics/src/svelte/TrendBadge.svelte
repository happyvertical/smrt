<script lang="ts">
interface Props {
  /** Direction of change: up, down, or flat. */
  trend: 'up' | 'down' | 'flat';
  /** Percent change; null means a zero baseline, shown as 'new' rather than 0%. */
  percent: number | null;
}

const { trend, percent }: Props = $props();

const arrow = $derived(
  trend === 'up' ? '\u2191' : trend === 'down' ? '\u2193' : '\u2192',
);

const display = $derived(percent === null ? 'new' : `${Math.abs(percent)}%`);
</script>

<span class="smrt-trend-badge__root" class:smrt-trend-badge__up={trend === 'up'} class:smrt-trend-badge__down={trend === 'down'} class:smrt-trend-badge__flat={trend === 'flat'} data-smrt-component="TrendBadge">
	<span class="smrt-trend-badge__arrow" data-smrt-part="marker" aria-hidden="true">{arrow}</span>
	<span class="smrt-trend-badge__percent" data-smrt-part="label">{display}</span>
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-trend-badge__root {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.5rem;
  }
}

@layer smrt.theme {
  .smrt-trend-badge__root {
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    line-height: 1;
  }
  .smrt-trend-badge__root.smrt-trend-badge__up {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-trend-badge__root.smrt-trend-badge__down {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-trend-badge__root.smrt-trend-badge__flat {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-trend-badge__arrow {
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }
}

</style>
