<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import {
  Combobox,
  type ControlInteractionOptions,
  emitControlChange,
  recordControlUserEdit,
  tryGetControlInteractionContext,
} from '@happyvertical/smrt-ui/forms';
import { untrack } from 'svelte';
import { logger } from '../../internal/logger.js';
import type { RelationOption } from './types.js';

/**
 * RelationInput - searchable single-select for relation (foreign key) fields.
 *
 * Presentation only: the caller supplies `search` (and optionally `resolve`),
 * so the same lookup an assistant uses to turn "Acme" into a record id backs
 * the picker. Built on the smrt-ui `Combobox`, which supplies the ARIA 1.2
 * combobox pattern (arrow keys, Enter, Escape, `aria-activedescendant`) and
 * registers with the rich Form's control registry. The form posts the
 * committed id under `name`, never the visible label.
 *
 * @example
 * ```svelte
 * <RelationInput
 *   name="customerId"
 *   label="Customer"
 *   bind:value={customerId}
 *   search={(q) => customers.search(q)}
 *   resolve={(id) => customers.byId(id)}
 * />
 * ```
 */
export interface Props {
  /** Field name; the selected id posts under it. */
  name: string;
  /** Visible label. */
  label: string;
  /** Selected record id (bindable). Empty string means no selection. */
  value?: string;
  /** Required field: hides the clear button and flags an empty value. */
  required?: boolean;
  /** Disabled state. */
  disabled?: boolean;
  /** Validation error message, shown below the field. */
  error?: string;
  /** Placeholder shown when nothing is selected. */
  placeholder?: string;
  /** Hint announced with the field. */
  description?: string;
  /** Look up records matching the text; called with '' when the list opens. */
  search: (query: string) => Promise<RelationOption[]>;
  /** Look up the current value's label when it has not been searched yet. */
  resolve?: (id: string) => Promise<{ id: string; label: string } | null>;
  /**
   * "New ..." action. Receives the text most recently searched for. May
   * return the created record, which is then selected.
   */
  onCreate?: (
    query: string,
  ) => void | RelationOption | Promise<void | RelationOption>;
  /** Milliseconds to wait after typing before searching. */
  debounceMs?: number;
  /** Combobox interaction options (stable id, subject) for agents. */
  interaction?: ControlInteractionOptions | false;
  /** Text for the "New ..." button. */
  createLabel?: string;
  /** Accessible name for the clear button. */
  clearLabel?: string;
  /** Status text while searching. */
  loadingText?: string;
  /** Status text when nothing matches. */
  emptyText?: string;
  /** Status text when the search fails. */
  errorText?: string;
  /** Status text announcing how many results are listed. */
  resultsText?: (count: number) => string;
  /** Called when the selected id changes ('' when cleared). */
  onchange?: (value: string) => void;
}

let {
  name,
  label,
  value = $bindable(''),
  required = false,
  disabled = false,
  error,
  placeholder,
  description,
  search,
  resolve,
  onCreate,
  debounceMs = 250,
  interaction,
  createLabel,
  clearLabel,
  loadingText = 'Searching…',
  emptyText = 'No matches',
  errorText = 'Search failed. Try again.',
  resultsText = (count: number) =>
    `${count} ${count === 1 ? 'result' : 'results'} available`,
  onchange,
}: Props = $props();

const instanceId = $props.id();
const errorId = `${instanceId}-error`;
const hintId = `${instanceId}-hint`;
const interactionContext = tryGetControlInteractionContext();

let rootEl = $state<HTMLDivElement | null>(null);
let results = $state<RelationOption[]>([]);
let loading = $state(false);
let failed = $state(false);
let selectedLabel = $state('');
let creating = $state(false);

// Plain bookkeeping, deliberately not reactive.
let labelledId = '';
let resolvingId = '';
let searchSeq = 0;
let lastQuery = '';
let timer: ReturnType<typeof setTimeout> | undefined;

const options = $derived(
  results.map((item) => ({ value: item.id, label: item.label })),
);
const detailById = $derived(
  new Map(results.map((item) => [item.id, item.detail])),
);
const status = $derived(
  loading
    ? loadingText
    : failed
      ? errorText
      : results.length === 0
        ? emptyText
        : resultsText(results.length),
);
const describedby = $derived(
  [error ? errorId : '', description ? hintId : ''].filter(Boolean).join(' ') ||
    undefined,
);
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name),
);
const canClear = $derived(!required && !disabled && value !== '');
const newLabel = $derived(createLabel ?? `New ${label.toLowerCase()}`);

async function runSearch(query: string) {
  const seq = ++searchSeq;
  loading = true;
  failed = false;
  try {
    const found = await search(query);
    if (seq !== searchSeq) return;
    results = found;
  } catch (err) {
    if (seq !== searchSeq) return;
    results = [];
    failed = true;
    logger.warn('[smrt-svelte] RelationInput search failed', {
      error: String(err),
    });
  } finally {
    if (seq === searchSeq) loading = false;
  }
}

function handleQuery(query: string) {
  clearTimeout(timer);
  lastQuery = query;
  if (query === '') {
    // Opening the list: no typing to wait for.
    void runSearch('');
    return;
  }
  // Show "Searching" straight away and drop any in-flight older request.
  searchSeq++;
  loading = true;
  failed = false;
  timer = setTimeout(() => void runSearch(query), debounceMs);
}

function handleValueChange(next: string) {
  lastQuery = '';
  const hit = results.find((item) => item.id === next);
  if (hit) {
    selectedLabel = hit.label;
    labelledId = next;
  }
  onchange?.(next);
}

function focusInput() {
  rootEl?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus();
}

function clear() {
  if (!canClear) return;
  value = '';
  selectedLabel = '';
  labelledId = '';
  lastQuery = '';
  onchange?.('');
  recordControlUserEdit(
    interactionContext,
    controlId,
    interaction === false ? undefined : interaction?.subject,
  );
  if (rootEl) emitControlChange(rootEl);
  focusInput();
}

async function create() {
  if (!onCreate || creating || disabled) return;
  // The field has already lost focus (and reset its text) by now, so use the
  // text most recently searched for.
  const typed = lastQuery;
  creating = true;
  try {
    const made = await onCreate(typed);
    if (made && typeof made === 'object') {
      results = [made, ...results.filter((item) => item.id !== made.id)];
      selectedLabel = made.label;
      labelledId = made.id;
      value = made.id;
      onchange?.(made.id);
      recordControlUserEdit(
        interactionContext,
        controlId,
        interaction === false ? undefined : interaction?.subject,
      );
      if (rootEl) emitControlChange(rootEl);
    }
  } catch (err) {
    logger.warn('[smrt-svelte] RelationInput onCreate failed', {
      error: String(err),
    });
  } finally {
    creating = false;
  }
}

// Keep the visible label in step with `value` however it changed (initial
// value, parent rebind, form reset): known from a search, else resolved.
$effect(() => {
  const id = value;
  const known = results.find((item) => item.id === id);
  untrack(() => {
    if (!id) {
      selectedLabel = '';
      labelledId = '';
      return;
    }
    if (id === labelledId) return;
    if (known) {
      selectedLabel = known.label;
      labelledId = id;
      return;
    }
    if (!resolve || resolvingId === id) return;
    selectedLabel = '';
    resolvingId = id;
    resolve(id)
      .then((record) => {
        if (value === id && record) {
          selectedLabel = record.label;
          labelledId = id;
        }
      })
      .catch((err) => {
        logger.warn('[smrt-svelte] RelationInput resolve failed', {
          error: String(err),
        });
      })
      .finally(() => {
        if (resolvingId === id) resolvingId = '';
      });
  });
});

$effect(() => () => clearTimeout(timer));
</script>

<div class="relation-input" bind:this={rootEl}>
  <div class="field">
    <Combobox
      {name}
      {label}
      {options}
      {placeholder}
      {disabled}
      {required}
      {interaction}
      {status}
      {describedby}
      bind:value
      valueLabel={selectedLabel}
      filter={false}
      busy={loading}
      invalid={!!error}
      onquery={handleQuery}
      onvaluechange={handleValueChange}
    >
      {#snippet optionContent(option)}
        <span class="option-label">{option.label}</span>
        {#if detailById.get(String(option.value))}
          <span class="option-detail">{detailById.get(String(option.value))}</span>
        {/if}
      {/snippet}
    </Combobox>
    {#if canClear}
      <Button
        variant="ghost"
        size="sm"
        class="clear"
        aria-label={clearLabel ?? `Clear ${label}`}
        onclick={clear}
      >
        &times;
      </Button>
    {/if}
  </div>
  {#if description}<p id={hintId} class="hint">{description}</p>{/if}
  {#if onCreate}
    <Button
      variant="ghost"
      size="sm"
      class="create"
      disabled={disabled || creating}
      onclick={create}
    >
      + {newLabel}
    </Button>
  {/if}
  {#if error}<p id={errorId} class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .relation-input {
    display: grid;
    gap: var(--smrt-spacing-1, 4px);
    min-width: 0;
  }
  .field {
    position: relative;
  }
  .field :global(.clear) {
    position: absolute;
    right: var(--smrt-spacing-1, 4px);
    bottom: var(--smrt-spacing-1, 4px);
  }
  .option-label,
  .option-detail {
    display: block;
  }
  .option-detail {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .hint,
  .error {
    margin: 0;
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }
  .hint {
    color: var(--smrt-color-on-surface-variant);
  }
  .error {
    color: var(--smrt-color-error);
  }
</style>
