<script lang="ts">
import { useDataSource } from '../data/context.ts';
import type { ActiveForm } from '../forms/active.ts';
import {
  blankFieldMap,
  fieldMapInputs,
  loadFieldMap,
  planFieldMapSave,
} from '../forms/fieldMap.ts';
import { catalogModels } from '../forms/shared.ts';
import type { FieldMapForm } from '../recipes/types.ts';
import FieldInput from './FieldInput.svelte';

interface FieldMapFormProps {
  active: ActiveForm<FieldMapForm>;
  /** The row to edit; omitted when creating. */
  id?: string;
  onsaved: () => void;
  oncancel: () => void;
}

let { active, id, onsaved, oncancel }: FieldMapFormProps = $props();

const source = useDataSource();
const inputs = $derived(fieldMapInputs(active, catalogModels));

// svelte-ignore state_referenced_locally
let values = $state<Record<string, unknown>>(
  blankFieldMap(active, catalogModels),
);
// svelte-ignore state_referenced_locally
let loaded = $state(id === undefined);
let error = $state('');

async function load(rowId: string) {
  values = await loadFieldMap(source, active, catalogModels, rowId);
  loaded = true;
}
// svelte-ignore state_referenced_locally
if (id !== undefined) void load(id);

async function save(event: SubmitEvent) {
  event.preventDefault();
  error = '';
  try {
    await source.apply(planFieldMapSave(active, catalogModels, values, id));
    onsaved();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Could not save.';
  }
}
</script>

{#if !loaded}
  <p>Loading...</p>
{:else}
  <form onsubmit={save}>
    <h3>{id === undefined ? `New ${active.form.label.toLowerCase()}` : `Edit ${active.form.label.toLowerCase()}`}</h3>
    {#each inputs as { field, catalogField } (field.id)}
      <FieldInput
        field={{ ...catalogField, required: field.required ?? catalogField.required }}
        label={field.label}
        help={field.help}
        idPrefix={active.form.id}
        value={values[field.id]}
        onchange={(value) => (values[field.id] = value)}
      />
    {/each}
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
