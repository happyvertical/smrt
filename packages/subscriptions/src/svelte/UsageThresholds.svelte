<script lang="ts">
import { Progress } from '@happyvertical/smrt-ui/feedback';
import type { ThresholdEvaluation } from '../types.js';

let {
  evaluations = [],
}: {
  evaluations?: ThresholdEvaluation[];
} = $props();
</script>

<div class="smrt-usage-thresholds" data-smrt-component="UsageThresholds">
  {#each evaluations as evaluation (`${evaluation.threshold.metricKey}:${evaluation.usage.windowStart.toISOString()}`)}
    <article
      class:smrt-usage-thresholds__warn={evaluation.state === 'warn'}
      class:smrt-usage-thresholds__blocked={evaluation.state === 'blocked'}
      class="smrt-usage-thresholds__row"
      data-smrt-part="row"
    >
      <div class="smrt-usage-thresholds__header" data-smrt-part="header">
        <strong>{evaluation.threshold.label ?? evaluation.threshold.metricKey}</strong>
        <span>{evaluation.usage.quantity} / {evaluation.threshold.limit}</span>
      </div>
      <Progress
        label={`${evaluation.threshold.label ?? evaluation.threshold.metricKey} usage`}
        max={1}
        value={Number.isFinite(evaluation.ratio)
          ? Math.min(1, evaluation.ratio)
          : 1}
      />
      <p>{evaluation.state}</p>
    </article>
  {/each}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {

.smrt-usage-thresholds {
display: grid;
gap: 0.75rem;

}
.smrt-usage-thresholds__row {
display: grid;
gap: 0.45rem;
padding: 0.875rem;

}
.smrt-usage-thresholds__header {
align-items: center;
display: flex;
justify-content: space-between;

}
.smrt-usage-thresholds p {
margin: 0;

}

}
@layer smrt.theme {

.smrt-usage-thresholds__row {
border: var(--smrt-hairline);
border-radius: var(--smrt-radius-md);

}
.smrt-usage-thresholds__row.smrt-usage-thresholds__warn {
border-color: var(--smrt-color-warning);

}
.smrt-usage-thresholds__row.smrt-usage-thresholds__blocked {
border-color: var(--smrt-color-error);

}
.smrt-usage-thresholds p {
color: var(--smrt-color-on-surface-variant);
font-size: var(--smrt-typography-body-medium-size, 0.875rem);

}

}

</style>
