<script lang="ts">
/**
 * Chart widget (#3727, #3888): bars, a line, a plain table, a donut or a single
 * headline value over labelled values, drawn from the loaded data. Every chart
 * carries its numbers as text (bar values inline, a visible table for `table`,
 * a visually hidden table for the line and the donut, the value itself for
 * `stat`) so it is readable without sight.
 */
import { useI18n } from '../i18n/index.js';
import { formatWidgetValue } from './format.js';
import { M } from './strings.js';
import type { ChartData } from './types.js';

export interface Props {
  /** Validated chart data to render, or null for the empty state. */
  data: ChartData | null;
  /** Requested chart presentation; unsupported values fall back to bars. */
  style?: string;
  /** Accessible heading shown above the chart. */
  title?: string;
  /** Locale used to format displayed numeric values. */
  locale?: string;
  /**
   * How much room the chart takes. `compact` is a sparkline for a card (a
   * line with no axis, labels or readout); `tall` gives a page's main chart
   * room. Default `regular`.
   */
  size?: 'compact' | 'regular' | 'tall';
  /**
   * Line: label the value axis (top, middle and bottom values, short form)
   * with light gridlines. Default on for `tall`.
   */
  valueAxis?: boolean;
  /**
   * Line: let the pointer and the arrow keys read each value in a tooltip
   * (a slider whose value text is the point). Default on for `tall`.
   */
  explore?: boolean;
  /**
   * Line: the peak and latest values under the chart. Default on; a page
   * that shows its own headline figures turns it off.
   */
  readout?: boolean;
}
let {
  data,
  style: requestedStyle = 'bar',
  title = '',
  locale = 'en',
  size = 'regular',
  valueAxis,
  explore,
  readout = true,
}: Props = $props();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const { t } = useI18n();
const uid = $props.id();
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
  STYLES.find((candidate) => candidate === requestedStyle) ?? 'bar',
);
/** Whether the line draws its value axis (`showAxis`, readable before it). */
function requestedAxis(): boolean {
  return size !== 'compact' && (valueAxis ?? size === 'tall');
}
const fmt = (value: number): string =>
  formatWidgetValue(value, {
    format: chart?.format ?? 'integer',
    currency: chart?.currency,
    locale,
  });
const max = $derived(Math.max(0, ...points.map((point) => point.value)));
const min = $derived(Math.min(0, ...points.map((point) => point.value)));
/** A round number at or above `value` (1, 2, 2.5 or 5 times a power of ten). */
function niceCeil(value: number): number {
  if (value <= 0) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((n) => value / power <= n) ?? 10;
  return step * power;
}
// The line's top: the peak, or with a value axis two round steps above zero
// (so the ticks read $0 / $50K / $100K and the peak never meets the frame).
const top = $derived(requestedAxis() && max > 0 ? niceCeil(max / 2) * 2 : max);
const span = $derived(top - min || 1);
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
// Line axis: at most three labels (first, middle, last), so long or many
// labels never overflow the chart's width.
const axisLabels = $derived.by(() => {
  if (points.length <= 2) return points.map((point) => point.label);
  const middle = points[Math.floor((points.length - 1) / 2)];
  return [points[0].label, middle.label, points[points.length - 1].label];
});
const peak = $derived(
  points.reduce<{ label: string; value: number } | null>(
    (best, point) => (!best || point.value > best.value ? point : best),
    null,
  ),
);
const summary = $derived(
  `${title}. ${t(M['ui.overview.chart.summary'], { count: points.length })}`,
);

// Line extras: the value axis and the explorable readout.
const compact = $derived(size === 'compact');
const showAxis = $derived(requestedAxis());
const explorable = $derived(!compact && (explore ?? size === 'tall'));
const short = (value: number): string =>
  formatWidgetValue(value, {
    format: chart?.format ?? 'integer',
    currency: chart?.currency,
    locale,
    compact: true,
  });
const axisValues = $derived([top, (top + min) / 2, min]);
/** A point's place in the 100 x 40 plot. */
function place(index: number): { x: number; y: number } {
  const point = points[index];
  const x = points.length === 1 ? 50 : (index / (points.length - 1)) * 100;
  const y = 36 - (((point?.value ?? 0) - min) / span) * 32;
  return { x, y };
}
let active = $state<number | null>(null);
const activePoint = $derived(
  active !== null && points[active]
    ? { ...points[active], ...place(active) }
    : null,
);
const activeText = $derived(
  activePoint
    ? t(M['ui.overview.chart.point'], {
        label: activePoint.label,
        value: fmt(activePoint.value),
      })
    : '',
);
function pointAt(event: PointerEvent) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  if (box.width <= 0 || points.length === 0) return;
  const ratio = Math.min(
    1,
    Math.max(0, (event.clientX - box.left) / box.width),
  );
  active = Math.round(ratio * (points.length - 1));
}
function step(event: KeyboardEvent) {
  const last = points.length - 1;
  if (last < 0) return;
  const current = active ?? -1;
  const next =
    event.key === 'ArrowRight' || event.key === 'ArrowUp'
      ? Math.min(last, current + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? Math.max(0, current < 0 ? last : current - 1)
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : null;
  if (next === null) return;
  event.preventDefault();
  active = next;
}
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

{#snippet linePlot(interactive: boolean)}
  <svg
    class="smrt-chart__line"
    viewBox="0 0 100 40"
    preserveAspectRatio="none"
    role={interactive ? undefined : 'img'}
    aria-label={interactive ? undefined : summary}
    aria-hidden={interactive ? 'true' : undefined}
  >
    {#if showAxis}
      {#each [4, 20, 36] as y (y)}
        <line class="smrt-chart__grid" x1="0" x2="100" y1={y} y2={y} vector-effect="non-scaling-stroke" />
      {/each}
    {/if}
    <polyline points={polyline} fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" />
    {#if activePoint}
      <line class="smrt-chart__guide" x1={activePoint.x} x2={activePoint.x} y1="0" y2="40" vector-effect="non-scaling-stroke" />
    {/if}
  </svg>
  {#if activePoint}
    <span class="smrt-chart__dot" style:inset-inline-start="{activePoint.x}%" style:inset-block-start="{(activePoint.y / 40) * 100}%" aria-hidden="true"></span>
    <span
      class="smrt-chart__tip"
      data-edge={activePoint.x < 15 ? 'start' : activePoint.x > 85 ? 'end' : undefined}
      style:inset-inline-start="{activePoint.x}%"
      aria-hidden="true"
    ><span>{activePoint.label}</span><strong>{fmt(activePoint.value)}</strong></span>
  {/if}
{/snippet}

{#if points.length === 0}
  <p class="smrt-chart__empty" data-smrt-component="Chart">{t(M['ui.overview.no_data'])}</p>
{:else if style === 'table'}
  <div class="smrt-chart smrt-chart--table" data-smrt-component="Chart">
    {@render dataTable(false)}
  </div>
{:else if style === 'stat'}
  {#if latest}
    <div class="smrt-chart smrt-chart--stat" data-smrt-component="Chart">
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
    <div class="smrt-chart smrt-chart--pie" data-smrt-component="Chart">
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
    <p class="smrt-chart__empty" data-smrt-component="Chart">{t(M['ui.overview.no_data'])}</p>
  {/if}
{:else if style === 'line'}
  <div class="smrt-chart smrt-chart--line" data-size={size} data-smrt-component="Chart">
    <div class="smrt-chart__frame" class:smrt-chart__frame--axis={showAxis}>
      {#if showAxis}
        <p class="smrt-chart__values" aria-hidden="true">
          {#each axisValues as value, index (index)}<span>{short(value)}</span>{/each}
        </p>
      {/if}
      <div class="smrt-chart__body">
        {#if explorable}
          <div
            class="smrt-chart__plot"
            role="slider"
            tabindex="0"
            aria-label={summary}
            aria-describedby="{uid}-explore"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, points.length - 1)}
            aria-valuenow={active ?? points.length - 1}
            aria-valuetext={activeText || (latest ? t(M['ui.overview.chart.point'], { label: latest.label, value: fmt(latest.value) }) : '')}
            onpointermove={pointAt}
            onpointerleave={() => (active = null)}
            onkeydown={step}
            onblur={() => (active = null)}
          >
            {@render linePlot(true)}
          </div>
        {:else}
          <div class="smrt-chart__plot">{@render linePlot(false)}</div>
        {/if}
        {#if !compact}
          <p class="smrt-chart__axis" aria-hidden="true">
            {#each axisLabels as label, index (index)}<span>{label}</span>{/each}
          </p>
        {/if}
      </div>
    </div>
    {#if explorable}<span id="{uid}-explore" class="smrt-chart__table">{t(M['ui.overview.chart.explore'])}</span>{/if}
    {#if readout && !compact && peak && latest}
      <p class="smrt-chart__readout">
        <span>{t(M['ui.overview.chart.peak'], { value: fmt(peak.value), label: peak.label })}</span>
        <span>{t(M['ui.overview.chart.latest'], { value: fmt(latest.value), label: latest.label })}</span>
      </p>
    {/if}
    {@render dataTable(true)}
  </div>
{:else}
  <ul class="smrt-chart__bars" aria-label={summary} data-smrt-component="Chart">
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
  .smrt-chart__line { display: block; inline-size: 100%; block-size: 7rem; overflow: visible; }
  .smrt-chart--line[data-size='compact'] .smrt-chart__line { block-size: 2.5rem; }
  .smrt-chart--line[data-size='tall'] .smrt-chart__line { block-size: 14rem; }
  .smrt-chart__frame { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--smrt-spacing-2); }
  .smrt-chart__frame--axis { grid-template-columns: auto minmax(0, 1fr); }
  .smrt-chart__body { display: grid; gap: var(--smrt-spacing-1); min-inline-size: 0; }
  .smrt-chart__values { display: flex; flex-direction: column; justify-content: space-between; margin: 0; block-size: 14rem; padding-block: calc(14rem * 0.1 - 0.5lh) calc(14rem * 0.1 - 0.5lh); box-sizing: border-box; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-small-size); font-variant-numeric: tabular-nums; text-align: end; }
  .smrt-chart--line:not([data-size='tall']) .smrt-chart__values { block-size: 7rem; padding-block: calc(7rem * 0.1 - 0.5lh); }
  .smrt-chart__grid { stroke: var(--smrt-color-outline-variant); stroke-width: 1; stroke-dasharray: 2 3; }
  .smrt-chart__plot { position: relative; border-radius: var(--smrt-radius-small); outline: none; touch-action: pan-y; }
  .smrt-chart__plot[role='slider'] { cursor: crosshair; }
  .smrt-chart__plot:focus-visible { outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color); outline-offset: var(--smrt-focus-ring-offset); }
  .smrt-chart__guide { stroke: var(--smrt-color-outline); stroke-width: 1; }
  .smrt-chart__dot { position: absolute; inline-size: 0.625rem; block-size: 0.625rem; border-radius: var(--smrt-radius-full); background: var(--smrt-color-primary); outline: var(--smrt-focus-ring-width) solid var(--smrt-color-surface); transform: translate(-50%, -50%); pointer-events: none; }
  .smrt-chart__tip { position: absolute; inset-block-start: 0; display: grid; gap: 0; padding: var(--smrt-spacing-1) var(--smrt-spacing-2); border-radius: var(--smrt-radius-small); background: var(--smrt-color-inverse-surface); color: var(--smrt-color-inverse-on-surface); font-size: var(--smrt-typography-label-medium-size); line-height: 1.3; white-space: nowrap; transform: translate(-50%, calc(-100% - var(--smrt-spacing-1))); pointer-events: none; box-shadow: var(--smrt-elevation-2); font-variant-numeric: tabular-nums; }
  .smrt-chart__tip[data-edge='start'] { transform: translate(0, calc(-100% - var(--smrt-spacing-1))); }
  .smrt-chart__tip[data-edge='end'] { transform: translate(-100%, calc(-100% - var(--smrt-spacing-1))); }

  .smrt-chart__axis { display: flex; justify-content: space-between; gap: var(--smrt-spacing-2); margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-large-size, 0.75rem); }
  .smrt-chart__axis span { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .smrt-chart__axis span:last-child { text-align: end; }
  .smrt-chart__readout { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--smrt-spacing-1) var(--smrt-spacing-3); margin: 0; color: var(--smrt-color-on-surface); font-size: var(--smrt-typography-body-small-size, 0.75rem); font-variant-numeric: tabular-nums; }
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
  @media (forced-colors: active) {
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
