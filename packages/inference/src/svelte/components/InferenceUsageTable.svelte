<script lang="ts">
/**
 * The Usage tab: `reportAiUsage()` buckets (#4751) by model, tier and/or
 * prompt key. Renders only the dimensions the report was grouped by, so it
 * works with the model dimension alone.
 */
import type { InferenceUsageDimension, InferenceUsageView } from '../types.js';
import { usageColumns } from '../types.js';

interface InferenceUsageTableProps {
  usage: InferenceUsageView | null;
  busy: boolean;
  onUsageGroupBy?: (by: InferenceUsageDimension[]) => void;
}

const { usage, busy, onUsageGroupBy }: InferenceUsageTableProps = $props();

const DIMENSIONS: Array<{ id: InferenceUsageDimension; label: string }> = [
  { id: 'model', label: 'Model' },
  { id: 'tier', label: 'Tier' },
  { id: 'prompt', label: 'Prompt key' },
];

const columns = $derived(usage ? usageColumns(usage) : []);

function regroup(event: Event): void {
  const form = (event.currentTarget as HTMLInputElement).form;
  if (!form || !onUsageGroupBy) return;
  const by = new FormData(form)
    .getAll('by')
    .map(String) as InferenceUsageDimension[];
  onUsageGroupBy(by.length > 0 ? by : ['model']);
}

function outcomes(value: Record<string, number> | undefined): string {
  const entries = Object.entries(value ?? {});
  return entries.length > 0
    ? entries.map(([label, count]) => `${label} ${count}`).join(', ')
    : '–';
}
</script>

<div class="iut" data-testid="inference-usage">
  {#if onUsageGroupBy}
    <form class="iut-group">
      <span class="iut-label">Group by</span>
      {#each DIMENSIONS as dimension (dimension.id)}
        <label>
          <input
            type="checkbox"
            name="by"
            value={dimension.id}
            checked={columns.includes(dimension.id)}
            disabled={busy}
            onchange={regroup}
          />
          {dimension.label}
        </label>
      {/each}
    </form>
  {/if}
  {#if !usage || usage.buckets.length === 0}
    <p class="iut-label">No usage recorded yet.</p>
  {:else}
    <table class="iut-table">
      <thead>
        <tr>
          {#each columns as column (column)}
            <th scope="col">{DIMENSIONS.find((entry) => entry.id === column)?.label ?? column}</th>
          {/each}
          <th scope="col">Calls</th>
          <th scope="col">Tokens</th>
          <th scope="col">Est. cost</th>
          <th scope="col">Outcomes</th>
        </tr>
      </thead>
      <tbody>
        {#each usage.buckets as bucket, index (index)}
          <tr>
            {#each columns as column (column)}
              <td>{bucket.key[column] ?? '(unattributed)'}</td>
            {/each}
            <td>{bucket.calls}</td>
            <td>{bucket.totalTokens}</td>
            <td>
              ${bucket.estimatedCost.toFixed(4)}
              {#if bucket.uncostedCalls}<span class="iut-label">({bucket.uncostedCalls} uncosted)</span>{/if}
            </td>
            <td>{outcomes(bucket.outcomes)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if usage.costBasis}<p class="iut-label">{usage.costBasis}</p>{/if}
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .iut {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .iut-group {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }
  .iut-table {
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .iut-table th,
  .iut-table td {
    text-align: left;
    padding: 0.25rem 0.75rem 0.25rem 0;
    border-bottom: var(--smrt-hairline);
  }
  .iut-label {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant);
  }
}
</style>
