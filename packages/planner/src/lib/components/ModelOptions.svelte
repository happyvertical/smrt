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
  /** The heading level of the model's title (3 by default). */
  headingLevel?: number;
}

let { model, hints, headingLevel = 3 }: ModelOptionsProps = $props();

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

<form class="smrt-model-options__root" onsubmit={save} aria-label={`Options for ${model.name}`} data-smrt-component="ModelOptions">
  <svelte:element this={`h${Math.min(headingLevel, 6)}`}>{model.name} options</svelte:element>
  <p class="smrt-model-options__hint" data-smrt-part="hint">
    Stored in the <code>{model.collection}</code> table. Switch fields on or
    off and set their label, help, default and order. Saved as field policies.
  </p>

  <fieldset>
    <legend>Exposure (can only be narrowed)</legend>
    <div class="smrt-model-options__surfaces" data-smrt-part="grid">
      {#each SURFACES as surface (surface)}
        <Switch
          checked={draft.exposure[surface]}
          disabled={exposure[surface].locked}
          onchange={(event) => (draft.exposure[surface] = event.currentTarget.checked)}
          label={`Expose ${model.name} over ${SURFACE_LABEL[surface]}${exposure[surface].available ? '' : ' (none declared)'}`}
        />
      {/each}
    </div>
  </fieldset>

  {#each seed as entry (entry.field.name)}
    {@const name = entry.field.name}
    {@const lockedOn = isFieldLockedOn(entry)}
    {@const frozen = entry.locked}
    {#if draft.fields[name]}
      <fieldset class="smrt-model-options__field" data-smrt-part="field">
        <legend><code>{name}</code> <span class="smrt-model-options__type" data-smrt-part="meta">{entry.field.type}</span></legend>
        <Switch
          checked={draft.fields[name].use}
          disabled={lockedOn}
          onchange={(event) => (draft.fields[name].use = event.currentTarget.checked)}
          label={`Use field ${name}${entry.required ? ' (required)' : frozen ? ' (locked)' : ''}`}
        />
        <div class="smrt-model-options__controls" data-smrt-part="grid">
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
          <fieldset class="smrt-model-options__default" disabled={frozen} data-smrt-part="value">
            <FieldInput
              field={{ ...entry.field, required: false }}
              modelId={model.id}
              creatable={false}
              label={`Default value for ${name}`}
              idPrefix={`default-${model.name}`}
              value={draft.fields[name].default}
              onchange={(value) => {
                draft.fields[name].default = value;
              }}
            />
          </fieldset>
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
    <p class="smrt-model-options__hint" data-smrt-part="hint">
      Hidden by the recipe: {hiddenByRecipe.join(', ')}.
    </p>
  {/if}

  <div class="smrt-model-options__actions" data-smrt-part="actions">
    <button type="submit">Save options</button>
    <button type="button" class="smrt-model-options__secondary" onclick={reset} data-smrt-part="action">
      Reset to recipe defaults
    </button>
  </div>
  <p class="smrt-model-options__status" role="status" aria-live="polite" data-smrt-part="status">{status}</p>
</form>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-model-options__root {
    display: grid;
    gap: var(--smrt-spacing-3);
  }
  h3,
  h4,
  h5,
  h6,
  p {
    margin: 0;
  }
  fieldset {
    display: grid;
    gap: var(--smrt-spacing-2);
    margin: 0;
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
  }
  .smrt-model-options__surfaces,
  .smrt-model-options__controls {
    display: grid;
    gap: var(--smrt-spacing-3);
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  }
  label {
    display: grid;
    gap: var(--smrt-spacing-1);
  }
  fieldset.smrt-model-options__default {
    padding: 0;
  }
  .smrt-model-options__actions {
    display: flex;
    gap: var(--smrt-spacing-2);
  }
  button {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    cursor: pointer;
  }
}

@layer smrt.theme {
  .smrt-model-options__hint,
  .smrt-model-options__type {
    color: var(--smrt-color-on-surface-variant);
  }
  fieldset {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-large);
  }
  label {
    font-weight: 500;
  }
  fieldset.smrt-model-options__default {
    border: 0;
  }
  fieldset.smrt-model-options__default:disabled {
    opacity: 0.6;
  }
  button {
    border: 0;
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font: inherit;
  }
  button.smrt-model-options__secondary {
    border: var(--smrt-control-border);
    background: transparent;
    color: var(--smrt-color-on-surface);
  }
  /* Forced colours: a disabled default reads as GrayText, not by opacity. */
  @media (forced-colors: active) {
    fieldset.smrt-model-options__default:disabled {
      color: GrayText;
      opacity: 1;
    }
  }
}

</style>
