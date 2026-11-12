<script lang="ts">
/**
 * Fusions from the registry, config and app config entries (#4753 owns
 * their meaning). Registry and config fusions are read-only; app entries
 * are edited as JSON. There is deliberately no authoring form.
 */
import type { InferenceFusionChange, InferenceFusionView } from '../types.js';

interface InferenceFusionListProps {
  fusions: InferenceFusionView[];
  editable: boolean;
  busy: boolean;
  onSaveFusion?: (change: InferenceFusionChange) => void;
}

const { fusions, editable, busy, onSaveFusion }: InferenceFusionListProps =
  $props();

let errors = $state<Record<string, string>>({});

function parse(name: string, raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors = { ...errors, [name]: 'A fusion is a JSON object.' };
      return null;
    }
    errors = { ...errors, [name]: '' };
    return value as Record<string, unknown>;
  } catch {
    errors = { ...errors, [name]: 'Not valid JSON.' };
    return null;
  }
}

function save(event: SubmitEvent, existing?: string): void {
  event.preventDefault();
  if (!onSaveFusion) return;
  const fields = new FormData(event.currentTarget as HTMLFormElement);
  const name = existing ?? String(fields.get('fusionName') ?? '').trim();
  if (!name) return;
  const definition = parse(
    existing ?? '__new__',
    String(fields.get('definition') ?? ''),
  );
  if (definition) onSaveFusion({ name, definition });
}
</script>

<div class="smrt-inference-fusion-list__root" data-testid="inference-fusions" data-smrt-component="InferenceFusionList">
  {#each fusions as fusion (fusion.name)}
    <div class="smrt-inference-fusion-list__item" data-smrt-part="row">
      <div class="smrt-inference-fusion-list__header" data-smrt-part="header">
        <strong>{fusion.name}</strong>
        <span class="smrt-inference-fusion-list__label" data-smrt-part="label">{fusion.source}</span>
        {#if fusion.shadows?.length}<span class="smrt-inference-fusion-list__label" data-smrt-part="label">replaces {fusion.shadows.join(', ')}</span>{/if}
        {#if fusion.description}<span class="smrt-inference-fusion-list__label" data-smrt-part="label">{fusion.description}</span>{/if}
      </div>
      {#if fusion.issues?.length}
        <ul class="smrt-inference-fusion-list__label" data-smrt-part="label" role="alert" data-testid="inference-fusion-issues">
          {#each fusion.issues as issue (issue.path + issue.message)}<li>{issue.message}</li>{/each}
        </ul>
      {/if}
      {#if editable && fusion.editable}
        <form onsubmit={(event) => save(event, fusion.name)}>
          <textarea
            name="definition"
            aria-label={`${fusion.name} JSON`}
            rows="6"
            disabled={busy}
            value={JSON.stringify(fusion.definition, null, 2)}
          ></textarea>
          {#if errors[fusion.name]}<p class="smrt-inference-fusion-list__label" data-smrt-part="label" role="alert">{errors[fusion.name]}</p>{/if}
          <div class="smrt-inference-fusion-list__actions" data-smrt-part="actions">
            <button type="submit" disabled={busy || !onSaveFusion}>Save</button>
            <button
              type="button"
              disabled={busy || !onSaveFusion}
              onclick={() => onSaveFusion?.({ name: fusion.name, definition: null })}
            >
              Remove
            </button>
          </div>
        </form>
      {:else}
        <pre class="smrt-inference-fusion-list__pre" data-smrt-part="message">{JSON.stringify(fusion.definition, null, 2)}</pre>
      {/if}
    </div>
  {:else}
    <p class="smrt-inference-fusion-list__label" data-smrt-part="label">No fusions are defined.</p>
  {/each}
  {#if editable && onSaveFusion}
    <form class="smrt-inference-fusion-list__item" data-smrt-part="row" onsubmit={(event) => save(event)} data-testid="inference-fusion-new">
      <label>
        <span class="smrt-inference-fusion-list__label" data-smrt-part="label">New config entry</span>
        <input name="fusionName" required disabled={busy} />
      </label>
      <textarea name="definition" aria-label="New fusion JSON" rows="4" disabled={busy}>{'{}'}</textarea>
      {#if errors.__new__}<p class="smrt-inference-fusion-list__label" data-smrt-part="label" role="alert">{errors.__new__}</p>{/if}
      <button type="submit" disabled={busy}>Add</button>
    </form>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-inference-fusion-list__root {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-inference-fusion-list__item {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .smrt-inference-fusion-list__header,
  .smrt-inference-fusion-list__actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .smrt-inference-fusion-list__pre,
  textarea {
    margin: 0;
    padding: 0.5rem;
    white-space: pre-wrap;
    width: 100%;
  }
  .smrt-inference-fusion-list__label {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-inference-fusion-list__pre,
  textarea {
    border-radius: 0.375rem;
    background: var(--smrt-color-surface-variant);
    font-family: ui-monospace, monospace;
    font-size: 0.8125rem;
  }
  .smrt-inference-fusion-list__label {
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
