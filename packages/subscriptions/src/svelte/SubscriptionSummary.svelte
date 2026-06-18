<script lang="ts">
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import type { EntitlementResolution } from '../types.js';
import { M } from './i18n.js';

let {
  resolution = null,
}: {
  resolution?: EntitlementResolution | null;
} = $props();

const { t } = useI18n();
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
