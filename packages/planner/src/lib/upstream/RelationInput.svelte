<!--
  STAND-IN for `RelationInput` of `@happyvertical/smrt-svelte/forms`
  (happyvertical/smrt#3600): a searchable single-select for relation fields,
  built on smrt-ui `Combobox`. Props follow the issue: `value`, `name`,
  `label`, `required`, `disabled`, `error`, a caller-supplied `search`, an
  optional `resolve` for the current value's label and an optional `onCreate`
  ("New ..." action). The smrt-svelte `Form` field-schema integration the
  issue lists is not reproduced here. When #3600 ships, import the published
  component and delete this file (and `relationTypes.ts`).

  The picker owns no data: `search` runs against whatever the caller has (the
  planner's DataSource). Typing searches after a short pause; opening the list
  shows the first results. Combobox filters by the text typed, so a hit's
  label includes its detail.
-->
<script lang="ts">
import { Combobox } from '@happyvertical/smrt-ui/forms';
import { onDestroy } from 'svelte';
import type {
  RelationOption,
  RelationResolve,
  RelationSearch,
} from './relationTypes.ts';

interface RelationInputProps {
  /** The selected record's id (bindable); empty when none. */
  value?: string;
  name: string;
  label: string;
  required?: boolean;
  disabled?: boolean;
  /** Message shown under the field; makes the field invalid. */
  error?: string;
  search: RelationSearch;
  resolve?: RelationResolve;
  /** Shows a "New ..." button; the caller opens its own form. */
  onCreate?: () => void;
  /** Text of the "New ..." button. */
  createLabel?: string;
  onchange?: (id: string) => void;
}

let {
  value = $bindable(''),
  name,
  label,
  required = false,
  disabled = false,
  error,
  search,
  resolve,
  onCreate,
  createLabel = 'New',
  onchange,
}: RelationInputProps = $props();

const DEBOUNCE_MS = 200;

let hits = $state<RelationOption[]>([]);
let valueLabel = $state('');
let status = $state<'idle' | 'loading' | 'empty'>('idle');
let loadedOnce = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let latest = 0;

const options = $derived(
  hits.map((hit) => ({
    value: hit.id,
    label: hit.detail ? `${hit.label} · ${hit.detail}` : hit.label,
  })),
);
const statusText = $derived(
  status === 'loading' ? 'Searching…' : status === 'empty' ? 'No matches' : '',
);

async function run(query: string) {
  const mine = ++latest;
  status = 'loading';
  try {
    const found = await search(query);
    if (mine !== latest) return;
    hits = found;
    status = found.length === 0 ? 'empty' : 'idle';
    loadedOnce = true;
  } catch {
    if (mine !== latest) return;
    hits = [];
    status = 'empty';
  }
}

function typed(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  clearTimeout(timer);
  const query = target.value;
  timer = setTimeout(() => void run(query), DEBOUNCE_MS);
}

function opened() {
  if (!loadedOnce) void run('');
}

// Show the current value's label, never its id.
$effect(() => {
  const id = value;
  if (!id) {
    valueLabel = '';
    return;
  }
  const known = hits.find((hit) => hit.id === id);
  if (known) {
    valueLabel = known.label;
    return;
  }
  if (!resolve) return;
  let stale = false;
  void resolve(id).then((found) => {
    if (!stale) valueLabel = found?.label ?? '';
  });
  return () => {
    stale = true;
  };
});

function changed(id: string) {
  onchange?.(id);
}

function clear() {
  value = '';
  onchange?.('');
}

onDestroy(() => clearTimeout(timer));
</script>

<div class="relation" role="group" aria-label={label}>
  <!-- Combobox owns the input; its input events bubble to the wrapper. -->
  <div class="control" oninput={typed} onfocusin={opened}>
    <Combobox
      bind:value
      {options}
      {name}
      {label}
      {required}
      {disabled}
      {valueLabel}
      placeholder="Type to search"
      onvaluechange={changed}
    />
  </div>
  <div class="actions">
    {#if value && !required && !disabled}
      <button type="button" class="secondary" onclick={clear}>
        Clear<span class="visually-hidden"> {label}</span>
      </button>
    {/if}
    {#if onCreate && !disabled}
      <button type="button" class="secondary" onclick={onCreate}>
        {createLabel}
      </button>
    {/if}
  </div>
  <p class="status" role="status" aria-live="polite">{statusText}</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .relation {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  .actions {
    display: flex;
    gap: var(--smrt-spacing-2);
  }

  .actions:empty {
    display: none;
  }

  .status,
  .error {
    margin: 0;
    font-size: 0.875rem;
  }

  .status {
    min-height: 1.25em;
    color: var(--smrt-color-on-surface-variant);
  }

  .error {
    color: var(--smrt-color-error);
  }

  button.secondary {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-medium);
    background: transparent;
    color: var(--smrt-color-on-surface);
    font: inherit;
    cursor: pointer;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
