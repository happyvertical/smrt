<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from './i18n.js';

export interface CommercialMetricView {
  metricKey: string;
  usage: number;
  allowance?: number;
  forecast?: number;
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
</script>

<section class="commercial-overview" aria-label={t(M['subscriptions.commercial.overview_label'])}>
  {#each metrics as metric (metric.metricKey)}
    <article>
      <header><strong>{metric.metricKey}</strong><span class:blocked={metric.thresholdState === 'blocked'}>{metric.thresholdState ?? 'ok'}</span></header>
      <dl>
        <div><dt>Usage</dt><dd>{metric.usage}</dd></div>
        <div><dt>Allowance</dt><dd>{metric.allowance ?? '—'}</dd></div>
        <div><dt>Forecast</dt><dd>{metric.forecast ?? '—'}</dd></div>
        <div><dt>Charge</dt><dd>{metric.charge == null ? '—' : `${metric.currency ?? 'USD'} ${metric.charge.toFixed(2)}`}</dd></div>
      </dl>
    </article>
  {/each}
</section>

<style>
.commercial-overview { display:grid; gap:.75rem; }
article { border:1px solid var(--smrt-color-outline-variant,#d8dde6); border-radius:var(--smrt-radius-md,8px); padding:1rem; }
header, dl, dl div { display:flex; justify-content:space-between; gap:1rem; }
dl { flex-wrap:wrap; margin:.75rem 0 0; }
dt { color:var(--smrt-color-on-surface-variant,#64748b); }
dd { margin:0; }
.blocked { color:var(--smrt-color-error,#dc2626); }
</style>
