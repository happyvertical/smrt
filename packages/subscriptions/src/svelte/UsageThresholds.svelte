<script lang="ts">
import type { ThresholdEvaluation } from '../types.js';

let {
  evaluations = [],
}: {
  evaluations?: ThresholdEvaluation[];
} = $props();
</script>

<div class="smrt-usage-thresholds">
  {#each evaluations as evaluation (`${evaluation.threshold.metricKey}:${evaluation.usage.windowStart.toISOString()}`)}
    <article
      class:warn={evaluation.state === 'warn'}
      class:blocked={evaluation.state === 'blocked'}
      class="smrt-usage-thresholds__row"
    >
      <div class="smrt-usage-thresholds__header">
        <strong>{evaluation.threshold.label ?? evaluation.threshold.metricKey}</strong>
        <span>{evaluation.usage.quantity} / {evaluation.threshold.limit}</span>
      </div>
      <progress
        aria-label={`${evaluation.threshold.label ?? evaluation.threshold.metricKey} usage`}
        max="1"
        value={Number.isFinite(evaluation.ratio)
          ? Math.min(1, evaluation.ratio)
          : 1}
      ></progress>
      <p>{evaluation.state}</p>
    </article>
  {/each}
</div>

<style>
  .smrt-usage-thresholds {
    display: grid;
    gap: 0.75rem;
  }

  .smrt-usage-thresholds__row {
    border: 1px solid var(--smrt-border, #d8dde6);
    border-radius: var(--smrt-radius-md, 8px);
    display: grid;
    gap: 0.45rem;
    padding: 0.875rem;
  }

  .smrt-usage-thresholds__row.warn {
    border-color: var(--smrt-color-warning, #d97706);
  }

  .smrt-usage-thresholds__row.blocked {
    border-color: var(--smrt-color-error, #dc2626);
  }

  .smrt-usage-thresholds__header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .smrt-usage-thresholds p {
    color: var(--smrt-muted, #64748b);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    margin: 0;
  }

  .smrt-usage-thresholds progress {
    inline-size: 100%;
  }
</style>
