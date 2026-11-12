<script lang="ts">
/**
 * The Usage tab: `reportAiUsage()` buckets (#4751) by model, tier, prompt
 * key, fusion and/or template hash. Renders only the dimensions the report
 * was grouped by, so it works with the model dimension alone. With
 * transcript counts (#4781) each row shows how many calls have a stored
 * transcript and links them (and each outcome label) to the host's
 * transcript route; transcript content is never rendered here.
 */
import type {
  InferenceTranscriptLinkFilters,
  InferenceUsageDimension,
  InferenceUsageView,
} from '../types.js';
import { transcriptLinkFilters, usageColumns } from '../types.js';

interface InferenceUsageTableProps {
  usage: InferenceUsageView | null;
  busy: boolean;
  /** Whether the app stores transcripts; `false` shows the status line. */
  transcriptsEnabled?: boolean | null;
  transcriptHref?: (
    filters: InferenceTranscriptLinkFilters,
  ) => string | null | undefined;
  onUsageGroupBy?: (by: InferenceUsageDimension[]) => void;
}

const {
  usage,
  busy,
  transcriptsEnabled = null,
  transcriptHref,
  onUsageGroupBy,
}: InferenceUsageTableProps = $props();

const DIMENSIONS: Array<{ id: InferenceUsageDimension; label: string }> = [
  { id: 'model', label: 'Model' },
  { id: 'tier', label: 'Tier' },
  { id: 'prompt', label: 'Prompt key' },
  { id: 'fusion', label: 'Fusion' },
  { id: 'template', label: 'Template' },
];

const columns = $derived(usage ? usageColumns(usage) : []);
const showTranscripts = $derived(
  !!usage?.buckets.some((bucket) => typeof bucket.transcripts === 'number'),
);

function href(
  key: Record<string, string | null | undefined>,
  outcome?: string,
): string | null {
  if (!usage || !transcriptHref) return null;
  return transcriptHref(transcriptLinkFilters(usage, key, outcome)) || null;
}

function outcomeEntries(
  value: Record<string, number> | undefined,
): Array<[string, number]> {
  return Object.entries(value ?? {});
}

function regroup(event: Event): void {
  const form = (event.currentTarget as HTMLInputElement).form;
  if (!form || !onUsageGroupBy) return;
  const by = new FormData(form)
    .getAll('by')
    .map(String) as InferenceUsageDimension[];
  onUsageGroupBy(by.length > 0 ? by : ['model']);
}
</script>

<div class="smrt-inference-usage-table__root" data-testid="inference-usage" data-smrt-component="InferenceUsageTable">
  {#if transcriptsEnabled === false}
    <p class="smrt-inference-usage-table__label" data-smrt-part="label" role="status" data-testid="inference-transcripts-off">
      Transcripts are off; turn them on with <code>inference.transcripts.enabled</code> (Advanced, Transcripts) or <code>SMRT_INFERENCE_TRANSCRIPTS=1</code>.
    </p>
  {/if}
  {#if onUsageGroupBy}
    <form class="smrt-inference-usage-table__group" data-smrt-part="field">
      <span class="smrt-inference-usage-table__label" data-smrt-part="label">Group by</span>
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
    <p class="smrt-inference-usage-table__label" data-smrt-part="label">No usage recorded yet.</p>
  {:else}
    <table class="smrt-inference-usage-table__table" data-smrt-part="table">
      <thead data-smrt-part="header">
        <tr>
          {#each columns as column (column)}
            <th scope="col">{DIMENSIONS.find((entry) => entry.id === column)?.label ?? column}</th>
          {/each}
          <th scope="col">Calls</th>
          <th scope="col">Tokens</th>
          <th scope="col">Est. cost</th>
          <th scope="col">Outcomes</th>
          {#if showTranscripts}<th scope="col">Transcripts</th>{/if}
        </tr>
      </thead>
      <tbody data-smrt-part="body">
        {#each usage.buckets as bucket, index (index)}
          <tr>
            {#each columns as column (column)}
              <td>{bucket.key[column] ?? '(unattributed)'}</td>
            {/each}
            <td>{bucket.calls}</td>
            <td>{bucket.totalTokens}</td>
            <td>
              ${bucket.estimatedCost.toFixed(4)}
              {#if bucket.uncostedCalls}<span class="smrt-inference-usage-table__label" data-smrt-part="label">({bucket.uncostedCalls} uncosted)</span>{/if}
            </td>
            <td>
              {#each outcomeEntries(bucket.outcomes) as [label, count], position (label)}
                {@const link = (bucket.transcripts ?? 0) > 0 ? href(bucket.key, label) : null}
                {#if position > 0}, {/if}
                {#if link}<a href={link} data-testid="inference-transcript-outcome-link">{label} {count}</a>{:else}{label} {count}{/if}
              {:else}
                –
              {/each}
            </td>
            {#if showTranscripts}
              {@const link = (bucket.transcripts ?? 0) > 0 ? href(bucket.key) : null}
              <td data-testid="inference-transcript-count">
                {#if link}<a href={link} data-testid="inference-transcript-link">{bucket.transcripts}</a>{:else}{bucket.transcripts ?? 0}{/if}
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
    {#if usage.costBasis}<p class="smrt-inference-usage-table__label" data-smrt-part="label">{usage.costBasis}</p>{/if}
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-inference-usage-table__root {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-inference-usage-table__group {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }
  .smrt-inference-usage-table__table th,
  .smrt-inference-usage-table__table td {
    padding: 0.25rem 0.75rem 0.25rem 0;
  }
  .smrt-inference-usage-table__label {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-inference-usage-table__table {
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .smrt-inference-usage-table__table th,
  .smrt-inference-usage-table__table td {
    text-align: left;
    border-bottom: var(--smrt-hairline);
  }
  .smrt-inference-usage-table__label {
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
