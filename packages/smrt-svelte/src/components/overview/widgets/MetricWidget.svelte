<script lang="ts">
/**
 * Metric widget (#3727): one number with an optional caption and change. It
 * renders from the loaded data only; the loader decides what the number means.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../../i18n/strings.overview.js';
import { formatWidgetValue } from '../format.js';
import { safeHref } from '../markdown.js';
import type { WidgetComponentProps } from '../types.js';
import { isRecord, type MetricWidgetData } from './data.js';

let { data, locale }: WidgetComponentProps<MetricWidgetData> = $props();

const { t } = useI18n();
const metric = $derived(isRecord(data) ? data : null);
const valid = $derived(
  metric !== null &&
    typeof metric.value === 'number' &&
    Number.isFinite(metric.value),
);
const text = $derived(
  valid && metric
    ? formatWidgetValue(metric.value, {
        format: metric.format,
        currency: metric.currency,
        locale,
      })
    : '',
);
const change = $derived(
  metric && typeof metric.change === 'number' && Number.isFinite(metric.change)
    ? metric.change
    : null,
);
const changeText = $derived(
  change === null || change === 0
    ? ''
    : t(
        M[
          change > 0
            ? 'ui.overview.metric.change_up'
            : 'ui.overview.metric.change_down'
        ],
        {
          value: formatWidgetValue(Math.abs(change) / 100, {
            format: 'percent',
            locale,
          }),
        },
      ),
);
const href = $derived(
  metric && typeof metric.href === 'string' ? safeHref(metric.href) : null,
);
</script>

{#if valid && metric}
  <div class="smrt-metric">
    {#if href}
      <a class="smrt-metric__value" {href}>{text}</a>
    {:else}
      <p class="smrt-metric__value">{text}</p>
    {/if}
    {#if typeof metric.label === 'string' && metric.label}
      <p class="smrt-metric__label">{metric.label}</p>
    {/if}
    {#if changeText}
      <p class="smrt-metric__change" data-direction={(change ?? 0) > 0 ? 'up' : 'down'}>
        <span aria-hidden="true">{(change ?? 0) > 0 ? '▲' : '▼'}</span>
        {changeText}
      </p>
    {/if}
  </div>
{:else}
  <p class="smrt-metric__label">{t(M['ui.overview.no_data'])}</p>
{/if}

<style>
  .smrt-metric { display: grid; gap: var(--smrt-spacing-1); }
  .smrt-metric__value { margin: 0; color: var(--smrt-color-on-surface); font-size: var(--smrt-typography-display-small-size, 2rem); font-weight: var(--smrt-typography-weight-medium, 500); line-height: 1.1; text-decoration: none; font-variant-numeric: tabular-nums; }
  a.smrt-metric__value:hover { text-decoration: underline; }
  a.smrt-metric__value:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; border-radius: var(--smrt-radius-small, 0.25rem); }
  .smrt-metric__label { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-medium-size, 0.875rem); }
  .smrt-metric__change { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-large-size, 0.875rem); }
</style>
