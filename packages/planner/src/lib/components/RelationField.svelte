<script lang="ts">
import { getModelByQualifiedName } from '../catalog/index.ts';
import type { CatalogField } from '../catalog/types.ts';
import { useDataSource } from '../data/context.ts';
import {
  resolveCustomer,
  resolveRelated,
  resolveVendor,
  searchCustomers,
  searchRelated,
  searchVendors,
} from '../data/labels.ts';
import type { ModelRecord } from '../data/source.ts';
import { modalInBody } from '../fields/modal.ts';
import { activeForms, isFieldMap } from '../forms/active.ts';
import { recipes } from '../recipes/index.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import RelationInput from '../upstream/RelationInput.svelte';
import { selectorFor } from '../upstream/selects.ts';
import FieldMapForm from './FieldMapForm.svelte';

interface RelationFieldProps {
  field: CatalogField;
  /** The stored value: the related record's id. */
  value: unknown;
  onchange: (value: unknown) => void;
  label: string;
  /** Form control name; unique on the page. */
  name: string;
  required: boolean;
  /** Offer "New ..." when an added recipe has a form for the target. */
  creatable?: boolean;
}

let {
  field,
  value,
  onchange,
  label,
  name,
  required,
  creatable = true,
}: RelationFieldProps = $props();

const source = useDataSource();
const targetId = $derived(field.related ?? '');
const target = $derived(getModelByQualifiedName(targetId)?.model);
// The package's registered selector for the target, else the generic picker.
const slot = $derived(selectorFor(targetId));
const createForm = $derived(
  creatable
    ? activeForms(recipeState.ids, recipes, targetId).find(isFieldMap)
    : undefined,
);
const targetName = $derived(target?.name.toLowerCase() ?? 'record');

// svelte-ignore state_referenced_locally
let selected = $state(typeof value === 'string' ? value : '');
// Follow the parent when it changes the value (a default, a reset).
$effect(() => {
  const next = typeof value === 'string' ? value : '';
  if (next !== selected) selected = next;
});

let creating = $state(false);
/** Bumped per open so the dialog's form starts empty each time. */
let createKey = $state(0);

function openCreate() {
  createKey++;
  creating = true;
}

function created(record: ModelRecord) {
  creating = false;
  selected = record.id;
  onchange(record.id);
}

function picked(id: string) {
  selected = id;
  onchange(id === '' ? null : id);
}
</script>

{#if !target}
  <!-- The target is not in the catalog: all there is to show is the id. -->
  <label class="plain">
    {label}
    <input
      type="text"
      {name}
      {required}
      value={selected}
      oninput={(event) => picked(event.currentTarget.value)}
    />
  </label>
{:else if slot?.kind === 'customer'}
  {@const Select = slot.component}
  <Select
    bind:value={selected}
    {name}
    {label}
    {required}
    search={(query: string) => searchCustomers(source, query)}
    resolve={(id: string) => resolveCustomer(source, id)}
    onCreate={createForm ? openCreate : undefined}
    createLabel={`New ${targetName}`}
    onchange={picked}
  />
{:else if slot?.kind === 'vendor'}
  {@const Select = slot.component}
  <Select
    bind:value={selected}
    {name}
    {label}
    {required}
    search={(query: string) => searchVendors(source, query)}
    resolve={(id: string) => resolveVendor(source, id)}
    onCreate={createForm ? openCreate : undefined}
    createLabel={`New ${targetName}`}
    onchange={picked}
  />
{:else}
  <RelationInput
    bind:value={selected}
    {name}
    {label}
    {required}
    search={(query) => searchRelated(source, target, query)}
    resolve={(id) => resolveRelated(source, target, id)}
    onCreate={createForm ? openCreate : undefined}
    createLabel={`New ${targetName}`}
    onchange={picked}
  />
{/if}

{#if createForm && creating}
  <dialog
    class="create"
    aria-label={`New ${targetName}`}
    {@attach modalInBody}
    onclose={() => (creating = false)}
  >
    {#key createKey}
      <FieldMapForm
        active={createForm}
        onsaved={created}
        oncancel={() => (creating = false)}
      />
    {/key}
  </dialog>
{/if}

<style>
  .plain {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  .create {
    width: min(40rem, 94vw);
    max-height: 90vh;
    padding: var(--smrt-spacing-2);
    overflow: auto;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }

  .create::backdrop {
    background: rgb(0 0 0 / 0.5);
  }
</style>
