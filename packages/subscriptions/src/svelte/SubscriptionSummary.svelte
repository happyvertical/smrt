<script lang="ts">
import type { EntitlementResolution } from '../types.js';

let {
  resolution = null,
}: {
  resolution?: EntitlementResolution | null;
} = $props();
</script>

<section class="smrt-subscription-summary">
  <div>
    <p class="smrt-subscription-summary__label">Current plan</p>
    <h2>{resolution?.planKey ?? 'No active plan'}</h2>
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
    color: var(--smrt-muted, #64748b);
    font-size: 0.8rem;
  }

  .smrt-subscription-summary dl {
    display: flex;
    gap: 1rem;
    margin: 0;
  }

  .smrt-subscription-summary dd {
    font-weight: 650;
    margin: 0;
  }
</style>
