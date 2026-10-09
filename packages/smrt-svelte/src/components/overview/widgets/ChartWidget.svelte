<script lang="ts">
/**
 * Chart widget (#3727): bars or a line over labelled values, drawn from the
 * loaded data. Every chart carries its numbers as text (bar values inline, a
 * visually hidden table for the line) so it is readable without sight.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../../i18n/strings.overview.js';
import { formatWidgetValue } from '../format.js';
import type { WidgetComponentProps } from '../types.js';
import { type ChartWidgetData, isRecord } from './data.js';

let { options, data, title, locale }: WidgetComponentProps<ChartWidgetData> =
  $props();

const { t } = useI18n();
const MAX_POINTS = 60;

const chart = $derived(isRecord(data) ? data : null);
const points = $derived.by(() => {
  if (!chart || !Array.isArray(chart.points)) return [];
  const out: { label: string; value: number }[] = [];
  for (const point of chart.points.slice(0, MAX_POINTS)) {
    if (
      isRecord(point) &&
      typeof point.label === 'string' &&
      typeof point.value === 'number' &&
      Number.isFinite(point.value)
    ) {
      out.push({ label: point.label, value: point.value });
    }
  }
  return out;
});
const style = $derived(options.style === 'line' ? 'line' : 'bar');
const fmt = (value: number): string =>
  formatWidgetValue(value, {
    format: chart?.format ?? 'integer',
    currency: chart?.currency,
    locale,
  });
const max = $derived(Math.max(0, ...points.map((point) => point.value)));
const min = $derived(Math.min(0, ...points.map((point) => point.value)));
const span = $derived(max - min || 1);
const polyline = $derived(
  points
    .map((point, index) => {
      const x = points.length === 1 ? 50 : (index / (points.length - 1)) * 100;
      const y = 36 - ((point.value - min) / span) * 32;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' '),
);
const summary = $derived(
  `${title}. ${t(M['ui.overview.chart.summary'], { count: points.length })}`,
);
</script>

{#if points.length === 0}
  <p class="smrt-chart__empty">{t(M['ui.overview.no_data'])}</p>
{:else if style === 'line'}
  <div class="smrt-chart">
    <svg class="smrt-chart__line" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={summary}>
      <polyline points={polyline} fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" />
    </svg>
    <p class="smrt-chart__axis" aria-hidden="true">
      <span>{points[0].label}</span>
      <span>{points[points.length - 1].label}</span>
    </p>
    <table class="smrt-chart__table">
      <caption>{t(M['ui.overview.chart.table'])}</caption>
      <thead>
        <tr>
          <th scope="col">{t(M['ui.overview.chart.label_column'])}</th>
          <th scope="col">{t(M['ui.overview.chart.value_column'])}</th>
        </tr>
      </thead>
      <tbody>
        {#each points as point, index (index)}
          <tr><th scope="row">{point.label}</th><td>{fmt(point.value)}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <ul class="smrt-chart__bars" aria-label={summary}>
    {#each points as point, index (index)}
      <li class="smrt-chart__row">
        <span class="smrt-chart__label">{point.label}</span>
        <span class="smrt-chart__track" aria-hidden="true">
          <span class="smrt-chart__bar" style:inline-size="{max > 0 ? (Math.max(0, point.value) / max) * 100 : 0}%"></span>
        </span>
        <span class="smrt-chart__value">{fmt(point.value)}</span>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .smrt-chart { display: grid; gap: var(--smrt-spacing-1); color: var(--smrt-color-primary); }
  .smrt-chart__line { inline-size: 100%; block-size: 7rem; overflow: visible; }
  .smrt-chart__axis { display: flex; justify-content: space-between; margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-large-size, 0.75rem); }
  .smrt-chart__bars { display: grid; gap: var(--smrt-spacing-2); margin: 0; padding: 0; list-style: none; }
  .smrt-chart__row { display: grid; grid-template-columns: minmax(4rem, 30%) minmax(0, 1fr) auto; align-items: center; gap: var(--smrt-spacing-2); font-size: var(--smrt-typography-body-medium-size, 0.875rem); color: var(--smrt-color-on-surface); }
  .smrt-chart__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .smrt-chart__track { display: block; block-size: 0.625rem; border-radius: var(--smrt-radius-full, 9999px); background: var(--smrt-color-surface-container-high); overflow: hidden; }
  .smrt-chart__bar { display: block; block-size: 100%; border-radius: inherit; background: var(--smrt-color-primary); }
  .smrt-chart__value { font-variant-numeric: tabular-nums; color: var(--smrt-color-on-surface-variant); }
  .smrt-chart__empty { margin: 0; color: var(--smrt-color-on-surface-variant); }
  .smrt-chart__table { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
</style>
