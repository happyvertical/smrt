<script lang="ts">
import { Input, Switch } from '@happyvertical/smrt-ui/forms';
import type { CatalogModel } from '../catalog/types.ts';
import {
  draftFrom,
  formFields,
  isFieldLockedOn,
  type ModelDraft,
  narrowedFromDraft,
  resolveExposure,
  rowsFromDraft,
  SURFACE_LABEL,
  SURFACES,
} from '../recipes/policy.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import type { RecipeModelHints } from '../recipes/types.ts';
import FieldInput from './FieldInput.svelte';

interface ModelOptionsProps {
  model: CatalogModel;
  /** The recipe's curation hints for this model. */
  hints?: RecipeModelHints;
}

let { model, hints }: ModelOptionsProps = $props();

function fresh(): ModelDraft {
  return draftFrom(
    model,
    hints,
    recipeState.rows,
    recipeState.narrowed[model.id] ?? [],
  );
}

// The draft is the form's own copy; it is only written back on Save.
let draft = $state<ModelDraft>(fresh());
let status = $state('');

// What the recipe starts from, so locks and hidden parameters are known.
const seed = $derived(formFields(model, hints));
const exposure = $derived(resolveExposure(model, hints));
const hiddenByRecipe = $derived(
  Object.entries(hints?.fields ?? {})
    .filter(([, hint]) => hint.visibility === 'hidden')
    .map(([name]) => name),
);

function save(event: SubmitEvent) {
  event.preventDefault();
  recipeState.save(
    model.id,
    rowsFromDraft(model, hints, draft),
    narrowedFromDraft(model, hints, draft),
  );
  status = 'Options saved. The views below use them.';
}

function reset() {
  recipeState.reset(model.id);
  draft = fresh();
  status = 'Options reset to the recipe defaults.';
}

function setOrder(name: string, raw: string) {
  const value = Number(raw);
  if (raw.trim() !== '' && Number.isFinite(value)) {
    draft.fields[name].order = value;
  }
}
</script>

<form class="options" onsubmit={save} aria-label={`Options for ${model.name}`}>
  <h3>{model.name} options</h3>
  <p class="hint">
    Stored in the <code>{model.collection}</code> table. Switch fields on or
    off and set their label, help, default and order. Saved as field policies.
  </p>

  <fieldset>
    <legend>Exposure (can only be narrowed)</legend>
    <div class="surfaces">
      {#each SURFACES as surface (surface)}
        <Switch
          checked={draft.exposure[surface]}
          disabled={exposure[surface].locked}
          onchange={(event) => (draft.exposure[surface] = event.currentTarget.checked)}
          aria-label={`Expose ${model.name} over ${SURFACE_LABEL[surface]}`}
          label={`${SURFACE_LABEL[surface]}${exposure[surface].available ? '' : ' (none declared)'}`}
        />
      {/each}
    </div>
  </fieldset>

  {#each seed as entry (entry.field.name)}
    {@const name = entry.field.name}
    {@const lockedOn = isFieldLockedOn(entry)}
    {@const frozen = entry.locked}
    {#if draft.fields[name]}
      <fieldset class="field">
        <legend><code>{name}</code> <span class="type">{entry.field.type}</span></legend>
        <Switch
          checked={draft.fields[name].use}
          disabled={lockedOn}
          onchange={(event) => (draft.fields[name].use = event.currentTarget.checked)}
          aria-label={`Use field ${name}`}
          label={entry.required
            ? 'Use this field (required)'
            : frozen
              ? 'Use this field (locked)'
              : 'Use this field'}
        />
        <div class="controls">
          <label>
            <span>Label</span>
            <Input
              bind:value={draft.fields[name].label}
              disabled={frozen}
              aria-label={`Label for ${name}`}
            />
          </label>
          <label>
            <span>Help text</span>
            <Input
              bind:value={draft.fields[name].help}
              disabled={frozen}
              aria-label={`Help text for ${name}`}
            />
          </label>
          <div class="default" class:disabled={frozen}>
            <FieldInput
              field={{ ...entry.field, required: false }}
              label={`Default value for ${name}`}
              idPrefix={`default-${model.name}`}
              value={draft.fields[name].default}
              onchange={(value) => {
                if (!frozen) draft.fields[name].default = value;
              }}
            />
          </div>
          <label>
            <span>Order</span>
            <Input
              type="number"
              value={draft.fields[name].order}
              disabled={frozen}
              oninput={(event) => setOrder(name, event.currentTarget.value)}
              aria-label={`Order of ${name}`}
            />
          </label>
        </div>
      </fieldset>
    {/if}
  {/each}

  {#if hiddenByRecipe.length}
    <p class="hint">
      Hidden by the recipe: {hiddenByRecipe.join(', ')}.
    </p>
  {/if}

  <div class="actions">
    <button type="submit">Save options</button>
    <button type="button" class="secondary" onclick={reset}>
      Reset to recipe defaults
    </button>
  </div>
  <p class="status" role="status" aria-live="polite">{status}</p>
</form>

<style>
  .options {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  h3,
  p {
    margin: 0;
  }

  .hint,
  .type {
    color: var(--smrt-color-on-surface-variant);
  }

  fieldset {
    display: grid;
    gap: var(--smrt-spacing-2);
    margin: 0;
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
  }

  .surfaces,
  .controls {
    display: grid;
    gap: var(--smrt-spacing-3);
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  }

  label {
    display: grid;
    gap: var(--smrt-spacing-1);
    font-weight: 500;
  }

  .default.disabled {
    opacity: 0.6;
    pointer-events: none;
  }

  .actions {
    display: flex;
    gap: var(--smrt-spacing-2);
  }

  button {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border: 0;
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font: inherit;
    cursor: pointer;
  }

  button.secondary {
    border: 1px solid var(--smrt-color-outline);
    background: transparent;
    color: var(--smrt-color-on-surface);
  }
</style>
