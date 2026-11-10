<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from './i18n.js';

export interface CommercialMetricView {
  metricKey: string;
  usage: number;
  allowance?: number;
  forecast?: number;
  /** Integer minor units of `currency` — `$19.99` is `1999` (#2401). */
  charge?: number;
  currency?: string;
  thresholdState?:
    | 'ok'
    | 'observed'
    | 'warned'
    | 'blocked'
    | 'approval_required';
}

let { metrics = [] }: { metrics?: CommercialMetricView[] } = $props();
const { t } = useI18n();

/**
 * Render `charge` for display.
 *
 * The stored value is integer minor units (#2401), so it has to be scaled back
 * to major units before formatting — otherwise a $0.40 charge renders as 40.00.
 * The currency's own minor-unit exponent is used rather than a hard-coded 100,
 * so zero-decimal currencies (JPY, KRW) are left alone.
 */
function formatCharge(metric: CommercialMetricView): string {
  if (metric.charge == null) return '—';
  const currency = metric.currency ?? 'USD';
  const format = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(metric.charge / 10 ** digits);
}
</script>

<section class="smrt-commercial-overview__root" aria-label={t(M['subscriptions.commercial.overview_label'])} data-smrt-component="CommercialOverview">
  {#each metrics as metric (metric.metricKey)}
    <article data-smrt-part="row">
      <header data-smrt-part="header"><strong>{metric.metricKey}</strong><span class:smrt-commercial-overview__blocked={metric.thresholdState === 'blocked'}>{metric.thresholdState ?? 'ok'}</span></header>
      <dl data-smrt-part="body">
        <div><dt>Usage</dt><dd>{metric.usage}</dd></div>
        <div><dt>Allowance</dt><dd>{metric.allowance ?? '—'}</dd></div>
        <div><dt>Forecast</dt><dd>{metric.forecast ?? '—'}</dd></div>
        <div><dt>Charge</dt><dd>{formatCharge(metric)}</dd></div>
      </dl>
    </article>
  {/each}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-commercial-overview__root {
    display:grid;
    gap:.75rem;
  }
  article {
    padding:1rem;
  }
  header, dl, dl div {
    display:flex;
    justify-content:space-between;
    gap:1rem;
  }
  dl {
    flex-wrap:wrap;
    margin:.75rem 0 0;
  }
  dd {
    margin:0;
  }
}

@layer smrt.theme {
  article {
    border:var(--smrt-hairline);
    border-radius:var(--smrt-radius-md);
  }
  dt {
    color:var(--smrt-color-on-surface-variant);
  }
  .smrt-commercial-overview__blocked {
    color:var(--smrt-color-error);
  }
}

</style>
