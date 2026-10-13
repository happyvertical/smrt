<script lang="ts">
/**
 * Chart widget (#3727, #3888): bars, a line, a plain table, a donut or a single
 * headline value over labelled values, drawn from the loaded data. Every chart
 * carries its numbers as text (bar values inline, a visible table for `table`,
 * a visually hidden table for the line and the donut, the value itself for
 * `stat`) so it is readable without sight.
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
const STYLES = ['bar', 'line', 'table', 'pie', 'stat'] as const;
const style = $derived(
  STYLES.find((candidate) => candidate === options.style) ?? 'bar',
);
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

// Donut: slices are percentages of the positive total on a circle whose
// path length is 100, so a segment's dash length is its share.
const total = $derived(
  points.reduce((sum, point) => sum + Math.max(0, point.value), 0),
);
const slices = $derived.by(() => {
  let offset = 0;
  return points.map((point, index) => {
    const share = total > 0 ? (Math.max(0, point.value) / total) * 100 : 0;
    const slice = { ...point, index, share, offset };
    offset += share;
    return slice;
  });
});
const percent = (share: number): string =>
  formatWidgetValue(share / 100, { format: 'percent', locale });

// Stat: the latest value, and its change against the one before.
const latest = $derived(points.at(-1));
const delta = $derived.by((): number | null => {
  if (
    chart &&
    typeof chart.delta === 'number' &&
    Number.isFinite(chart.delta)
  ) {
    return chart.delta;
  }
  const previous = points.at(-2);
  if (!latest || !previous || previous.value === 0) return null;
  return ((latest.value - previous.value) / Math.abs(previous.value)) * 100;
});
const deltaText = $derived(
  delta === null || delta === 0
    ? ''
    : t(
        M[
          delta > 0
            ? 'ui.overview.metric.change_up'
            : 'ui.overview.metric.change_down'
        ],
        {
          value: formatWidgetValue(Math.abs(delta) / 100, {
            format: 'percent',
            locale,
          }),
        },
      ),
);
const summary = $derived(
  `${title}. ${t(M['ui.overview.chart.summary'], { count: points.length })}`,
);
</script>

{#snippet dataTable(hidden: boolean)}
  <table class={hidden ? 'smrt-chart__table' : 'smrt-chart__data'}>
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
{/snippet}

{#if points.length === 0}
  <p class="smrt-chart__empty" data-smrt-component="ChartWidget">{t(M['ui.overview.no_data'])}</p>
{:else if style === 'table'}
  <div class="smrt-chart smrt-chart--table" data-smrt-component="ChartWidget">
    {@render dataTable(false)}
  </div>
{:else if style === 'stat'}
  {#if latest}
    <div class="smrt-chart smrt-chart--stat" data-smrt-component="ChartWidget">
      <p class="smrt-chart__headline">{fmt(latest.value)}</p>
      <p class="smrt-chart__caption">{latest.label}</p>
      {#if deltaText}
        <p class="smrt-chart__delta" data-direction={(delta ?? 0) > 0 ? 'up' : 'down'}>
          <span aria-hidden="true">{(delta ?? 0) > 0 ? '▲' : '▼'}</span>
          {deltaText}
        </p>
      {/if}
    </div>
  {/if}
{:else if style === 'pie'}
  {#if total > 0}
    <div class="smrt-chart smrt-chart--pie" data-smrt-component="ChartWidget">
      <svg class="smrt-chart__donut" viewBox="0 0 42 42" role="img" aria-label={summary}>
        {#each slices as slice (slice.index)}
          {#if slice.share > 0}
            <circle
              class="smrt-chart__slice"
              data-slot={slice.index % 8}
              cx="21"
              cy="21"
              r="15.9155"
              fill="none"
              stroke-width="6"
              pathLength="100"
              stroke-dasharray="{slice.share} {100 - slice.share}"
              stroke-dashoffset={-slice.offset}
              transform="rotate(-90 21 21)"
            />
          {/if}
        {/each}
      </svg>
      <ul class="smrt-chart__legend" aria-hidden="true">
        {#each slices as slice (slice.index)}
          <li class="smrt-chart__legend-item">
            <span class="smrt-chart__swatch" data-slot={slice.index % 8}></span>
            <span class="smrt-chart__label">{slice.label}</span>
            <span class="smrt-chart__value">{fmt(slice.value)} · {percent(slice.share)}</span>
          </li>
        {/each}
      </ul>
      {@render dataTable(true)}
    </div>
  {:else}
    <p class="smrt-chart__empty" data-smrt-component="ChartWidget">{t(M['ui.overview.no_data'])}</p>
  {/if}
{:else if style === 'line'}
  <div class="smrt-chart" data-smrt-component="ChartWidget">
    <svg class="smrt-chart__line" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={summary}>
      <polyline points={polyline} fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" />
    </svg>
    <p class="smrt-chart__axis" aria-hidden="true">
      <span>{points[0].label}</span>
      <span>{points[points.length - 1].label}</span>
    </p>
    {@render dataTable(true)}
  </div>
{:else}
  <ul class="smrt-chart__bars" aria-label={summary} data-smrt-component="ChartWidget">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-chart { display: grid; gap: var(--smrt-spacing-1); color: var(--smrt-color-primary); }
  .smrt-chart__line { inline-size: 100%; block-size: 7rem; overflow: visible; }
  .smrt-chart__axis { display: flex; justify-content: space-between; margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-large-size, 0.75rem); }
  .smrt-chart__bars { display: grid; gap: var(--smrt-spacing-2); margin: 0; padding: 0; list-style: none; }
  .smrt-chart__row { display: grid; grid-template-columns: minmax(4rem, 30%) minmax(0, 1fr) auto; align-items: center; gap: var(--smrt-spacing-2); font-size: var(--smrt-typography-body-medium-size, 0.875rem); color: var(--smrt-color-on-surface); }
  .smrt-chart__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .smrt-chart__track { display: block; block-size: 0.625rem; border-radius: var(--smrt-radius-full); background: var(--smrt-color-surface-container-high); overflow: hidden; }
  .smrt-chart__bar { display: block; block-size: 100%; border-radius: inherit; background: var(--smrt-color-primary); }
  .smrt-chart__value { font-variant-numeric: tabular-nums; color: var(--smrt-color-on-surface-variant); }
  .smrt-chart__empty { margin: 0; color: var(--smrt-color-on-surface-variant); }
  .smrt-chart--table { color: var(--smrt-color-on-surface); }
  .smrt-chart__data { inline-size: 100%; border-collapse: collapse; font-size: var(--smrt-typography-body-medium-size, 0.875rem); }
  .smrt-chart__data caption { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  .smrt-chart__data th, .smrt-chart__data td { padding: var(--smrt-spacing-1) var(--smrt-spacing-2); border-block-end: var(--smrt-hairline); text-align: start; }
  .smrt-chart__data thead th { background: var(--smrt-surface-sunken); color: var(--smrt-color-on-surface-variant); font-weight: var(--smrt-typography-weight-medium, 500); }
  .smrt-chart__data tbody th { font-weight: inherit; overflow-wrap: anywhere; }
  .smrt-chart__data td, .smrt-chart__data thead th:last-child { text-align: end; font-variant-numeric: tabular-nums; }
  .smrt-chart--stat { gap: var(--smrt-spacing-1); color: var(--smrt-color-on-surface); }
  .smrt-chart__headline { margin: 0; font-size: var(--smrt-typography-display-small-size, 2rem); font-weight: var(--smrt-typography-weight-medium, 500); line-height: 1.1; font-variant-numeric: tabular-nums; }
  .smrt-chart__caption { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-medium-size, 0.875rem); }
  .smrt-chart__delta { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-large-size, 0.875rem); }
  .smrt-chart--pie { grid-template-columns: minmax(6rem, 10rem) minmax(0, 1fr); align-items: center; gap: var(--smrt-spacing-4); }
  .smrt-chart__donut { inline-size: 100%; block-size: auto; }
  .smrt-chart__slice[data-slot='0'], .smrt-chart__swatch[data-slot='0'] { stroke: var(--smrt-color-primary); background: var(--smrt-color-primary); }
  .smrt-chart__slice[data-slot='1'], .smrt-chart__swatch[data-slot='1'] { stroke: var(--smrt-color-secondary); background: var(--smrt-color-secondary); }
  .smrt-chart__slice[data-slot='2'], .smrt-chart__swatch[data-slot='2'] { stroke: var(--smrt-color-tertiary); background: var(--smrt-color-tertiary); }
  .smrt-chart__slice[data-slot='3'], .smrt-chart__swatch[data-slot='3'] { stroke: var(--smrt-color-info); background: var(--smrt-color-info); }
  .smrt-chart__slice[data-slot='4'], .smrt-chart__swatch[data-slot='4'] { stroke: var(--smrt-color-primary-container); background: var(--smrt-color-primary-container); }
  .smrt-chart__slice[data-slot='5'], .smrt-chart__swatch[data-slot='5'] { stroke: var(--smrt-color-secondary-container); background: var(--smrt-color-secondary-container); }
  .smrt-chart__slice[data-slot='6'], .smrt-chart__swatch[data-slot='6'] { stroke: var(--smrt-color-tertiary-container); background: var(--smrt-color-tertiary-container); }
  .smrt-chart__slice[data-slot='7'], .smrt-chart__swatch[data-slot='7'] { stroke: var(--smrt-color-info-container); background: var(--smrt-color-info-container); }
  .smrt-chart__legend { display: grid; gap: var(--smrt-spacing-1); margin: 0; padding: 0; list-style: none; color: var(--smrt-color-on-surface); font-size: var(--smrt-typography-body-medium-size, 0.875rem); }
  .smrt-chart__legend-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--smrt-spacing-2); }
  .smrt-chart__swatch { inline-size: 0.75rem; block-size: 0.75rem; border-radius: var(--smrt-radius-small); }
  .smrt-chart__legend .smrt-chart__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (prefers-reduced-motion: no-preference) {
    .smrt-chart__slice { transition: stroke-dasharray var(--smrt-duration-normal) var(--smrt-easing-standard), stroke-dashoffset var(--smrt-duration-normal) var(--smrt-easing-standard); }
    .smrt-chart__bar { transition: inline-size var(--smrt-duration-normal) var(--smrt-easing-standard); }
  }
  .smrt-chart__table { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  /* Forced colors (#3908): selected and open states keep a non-colour indicator. */
  @media (forced-colors: active) {
    /* Series keys: system colours cycle by slot (the user's own palette), so
       slices and legend swatches stay distinguishable without author colours.
       The legend always carries label, value and share as text. */
    .smrt-chart__slice[data-slot='0'], .smrt-chart__swatch[data-slot='0'] { stroke: CanvasText; background: CanvasText; }
    .smrt-chart__slice[data-slot='1'], .smrt-chart__swatch[data-slot='1'] { stroke: Highlight; background: Highlight; }
    .smrt-chart__slice[data-slot='2'], .smrt-chart__swatch[data-slot='2'] { stroke: LinkText; background: LinkText; }
    .smrt-chart__slice[data-slot='3'], .smrt-chart__swatch[data-slot='3'] { stroke: VisitedText; background: VisitedText; }
    .smrt-chart__slice[data-slot='4'], .smrt-chart__swatch[data-slot='4'] { stroke: ActiveText; background: ActiveText; }
    .smrt-chart__slice[data-slot='5'], .smrt-chart__swatch[data-slot='5'] { stroke: GrayText; background: GrayText; }
    .smrt-chart__slice[data-slot='6'], .smrt-chart__swatch[data-slot='6'] { stroke: ButtonText; background: ButtonText; }
    .smrt-chart__slice[data-slot='7'], .smrt-chart__swatch[data-slot='7'] { stroke: MarkText; background: MarkText; }
    .smrt-chart__swatch { border: var(--smrt-hairline-strong); }
    .smrt-chart__slice { stroke-linecap: butt; }
    .smrt-chart__track { background: Canvas; border: var(--smrt-hairline-strong); }
    .smrt-chart__bar { background: Highlight; }
  }
}
</style>
