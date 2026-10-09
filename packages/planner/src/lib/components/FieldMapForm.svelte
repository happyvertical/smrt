<script lang="ts">
import { tick } from 'svelte';
import { errorSummary, missingRequired } from '../data/columns.ts';
import { useDataSource } from '../data/context.ts';
import { createNoun } from '../data/format.ts';
import type { ModelRecord } from '../data/source.ts';
import { focusFirstInvalid } from '../fields/invalid.ts';
import type { ActiveForm } from '../forms/active.ts';
import {
  blankFieldMap,
  fieldMapInputs,
  fieldMapParts,
  loadFieldMapState,
  planFieldMapSave,
  primaryIndex,
} from '../forms/fieldMap.ts';
import { catalogModels } from '../forms/shared.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import type { FieldMapForm } from '../recipes/types.ts';
import FieldInput from './FieldInput.svelte';

interface FieldMapFormProps {
  active: ActiveForm<FieldMapForm>;
  /** The row to edit; omitted when creating. */
  id?: string;
  /** Called with the saved row of the form's own model. */
  onsaved: (saved: ModelRecord) => void;
  oncancel: () => void;
  /** Values a NEW row carries, e.g. the filter of the page it was added on. */
  preset?: Record<string, unknown>;
  /** What the page calls one record ("member"); wins over the form's label. */
  noun?: string;
}

let { active, id, onsaved, oncancel, preset, noun }: FieldMapFormProps =
  $props();

const source = useDataSource();
// An option row that hides a field (a cookbook's, or the visitor's) takes it
// out of the form too.
const inputs = $derived(
  fieldMapInputs(active, catalogModels).filter(
    ({ catalogField, modelId }) =>
      !recipeState.rows.some(
        (row) =>
          row.objectRef === modelId &&
          row.fieldName === catalogField.name &&
          row.visibility === 'hidden',
      ),
  ),
);

// svelte-ignore state_referenced_locally
let values = $state<Record<string, unknown>>(
  blankFieldMap(active, catalogModels),
);
// svelte-ignore state_referenced_locally
let loaded = $state(id === undefined);
let error = $state('');
let errors = $state<Record<string, string>>({});
const requiredFields = $derived(
  inputs.map(({ field, catalogField }) => ({
    ...catalogField,
    name: field.id,
    label: field.label,
    required: field.required ?? catalogField.required,
  })),
);
const summary = $derived(errorSummary(requiredFields, errors));
/** The rows an edited row's records point at; see `planFieldMapSave`. */
let rows: Record<string, ModelRecord | undefined> = {};

async function load(rowId: string) {
  const state = await loadFieldMapState(source, active, catalogModels, rowId);
  values = state.values;
  rows = state.rows;
  loaded = true;
}
// svelte-ignore state_referenced_locally
if (id !== undefined) void load(id);

async function save(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget;
  error = '';
  errors = missingRequired(requiredFields, values);
  if (Object.keys(errors).length > 0) {
    await tick();
    focusFirstInvalid(form);
    return;
  }
  try {
    const written = await source.apply(
      planFieldMapSave(active, catalogModels, values, id, rows, preset),
    );
    const primary = fieldMapParts(active).records[primaryIndex(active)];
    const saved = primary ? written[primary.as] : undefined;
    if (!saved) throw new Error('Nothing was saved.');
    onsaved(saved);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Could not save.';
  }
}
</script>

{#if !loaded}
  <p>Loading...</p>
{:else}
  <form onsubmit={save} novalidate>
    <h3>{id === undefined ? 'New' : 'Edit'} {createNoun(active.form.label, noun, noun !== undefined)}</h3>
    {#each inputs as { field, catalogField, modelId } (field.id)}
      <FieldInput
        {modelId}
        field={{ ...catalogField, required: field.required ?? catalogField.required }}
        label={field.label}
        help={field.help}
        idPrefix={active.form.id}
        error={errors[field.id]}
        value={values[field.id]}
        onchange={(value) => {
          values[field.id] = value;
          delete errors[field.id];
        }}
      />
    {/each}
    {#if summary}<p class="error" role="alert" data-error-summary>{summary}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="actions">
      <button type="submit">Save</button>
      <button type="button" class="secondary" onclick={oncancel}>Cancel</button>
    </div>
  </form>
{/if}

<style>
  form {
    display: grid;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-4);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
  }

  h3 {
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--smrt-spacing-2);
  }

  .error {
    margin: 0;
    color: var(--smrt-color-error);
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
