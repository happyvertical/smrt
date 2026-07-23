<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { EntitlementResolution } from '../types.js';
import { M } from './i18n.js';

let {
  resolution = null,
  periodEnd = null,
  periodDisposition = 'unknown',
}: {
  resolution?: EntitlementResolution | null;
  /** ISO date string (or null) for the current billing period end. */
  periodEnd?: string | null;
  /** How to describe `periodEnd`: renews / ends / perpetual / unknown. */
  periodDisposition?: 'perpetual' | 'renews' | 'ends' | 'unknown';
} = $props();

const { t } = useI18n();

const periodLabel = $derived(
  periodDisposition === 'perpetual'
    ? t(M['subscriptions.summary.no_expiration'])
    : periodDisposition === 'renews' && periodEnd
      ? `${t(M['subscriptions.summary.renews'])} ${new Date(periodEnd).toLocaleDateString()}`
      : periodDisposition === 'ends' && periodEnd
        ? `${t(M['subscriptions.summary.ends'])} ${new Date(periodEnd).toLocaleDateString()}`
        : null,
);
</script>

<section class="smrt-subscription-summary">
  <div>
    <p class="smrt-subscription-summary__label">{t(M['subscriptions.summary.current_plan'])}</p>
    <h2>{resolution?.planKey ?? t(M['subscriptions.summary.no_active_plan'])}</h2>
  </div>
  <dl>
    <div>
      <dt>Status</dt>
      <dd>{resolution?.status ?? 'none'}</dd>
    </div>
    <div>
      <dt>Features</dt>
      <dd>{resolution?.featureKeys.length ?? 0}</dd>
    </div>
    <div>
      <dt>Thresholds</dt>
      <dd>{resolution?.thresholds.length ?? 0}</dd>
    </div>
    {#if periodLabel}
      <div>
        <dt>{t(M['subscriptions.summary.period'])}</dt>
        <dd>{periodLabel}</dd>
      </div>
    {/if}
  </dl>
</section>

<style>
  .smrt-subscription-summary {
    align-items: center;
    display: flex;
    gap: 1rem;
    justify-content: space-between;
  }

  .smrt-subscription-summary h2,
  .smrt-subscription-summary__label {
    margin: 0;
  }

  .smrt-subscription-summary__label,
  .smrt-subscription-summary dt {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-label-medium-size, 0.8rem);
  }

  .smrt-subscription-summary dl {
    display: flex;
    gap: 1rem;
    margin: 0;
  }

  .smrt-subscription-summary dd {
    font-weight: var(--smrt-typography-weight-bold, 650);
    margin: 0;
  }
</style>
