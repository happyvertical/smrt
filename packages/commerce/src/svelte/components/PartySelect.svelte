<script lang="ts" generics="T extends CustomerDisplayData | VendorDisplayData">
import {
  Combobox,
  type ControlInteractionOptions,
  emitControlChange,
  recordControlUserEdit,
  tryGetControlInteractionContext,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { untrack } from 'svelte';
import { M } from '../i18n.js';
import type { CustomerDisplayData, VendorDisplayData } from '../party-types.js';

/**
 * Shared searchable party picker behind `CustomerSelect` and `VendorSelect`.
 * Presentation only: the caller owns `search` and `resolve`, so the lookup an
 * assistant uses to turn a name into a record id also backs the field. The
 * committed id posts under `name`, never the visible profile name.
 */
export interface Props<Party> {
  /** Which party this picks; selects the default label, hints and detail line. */
  kind: 'customer' | 'vendor';
  /** Field name; the selected id posts under it. */
  name: string;
  /** Selected record id (bindable). Empty string means no selection. */
  value?: string;
  /** Visible label. Defaults to the localized party name. */
  label?: string;
  /** Required field: hides the clear button. */
  required?: boolean;
  /** Disabled state. */
  disabled?: boolean;
  /** Validation error shown below the field. */
  error?: string;
  /** Placeholder shown while nothing is selected. */
  placeholder?: string;
  /** Hint announced with the field. */
  description?: string;
  /** Caller-owned lookup; called with '' when the list opens. */
  search: (query: string) => Promise<Party[]>;
  /** Caller-owned lookup of the current value when it has not been listed yet. */
  resolve?: (id: string) => Promise<Party | null>;
  /**
   * "New ..." action, offered only when supplied. Receives the text most
   * recently searched for; a returned record is selected.
   */
  onCreate?: (query: string) => void | Party | Promise<void | Party>;
  /** Text for the "New ..." button. */
  createLabel?: string;
  /** Milliseconds to wait after typing before searching. */
  debounceMs?: number;
  /** Combobox interaction options for agents, or false to opt out. */
  interaction?: ControlInteractionOptions | false;
  /** Called when the selected id changes ('' when cleared). */
  onchange?: (id: string) => void;
}

let {
  kind,
  name,
  value = $bindable(''),
  label,
  required = false,
  disabled = false,
  error,
  placeholder,
  description,
  search,
  resolve,
  onCreate,
  createLabel,
  debounceMs = 250,
  interaction,
  onchange,
}: Props<T> = $props();

interface Option {
  id: string;
  label: string;
  detail?: string;
}

const { t } = useI18n();
const instanceId = $props.id();
const interactionContext = tryGetControlInteractionContext();
const errorId = `${instanceId}-error`;
const hintId = `${instanceId}-hint`;

let rootEl = $state<HTMLDivElement | null>(null);
let results = $state<Option[]>([]);
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

const fieldLabel = $derived(
  label ??
    t(
      kind === 'customer'
        ? M['commerce.customer.singular']
        : M['commerce.vendor.singular'],
    ),
);
const fieldPlaceholder = $derived(
  placeholder ??
    t(
      kind === 'customer'
        ? M['commerce.customer.search']
        : M['commerce.vendor.search'],
    ),
);
const newLabel = $derived(
  createLabel ??
    t(
      kind === 'customer'
        ? M['commerce.select.new_customer']
        : M['commerce.select.new_vendor'],
    ),
);
const clearName = $derived(
  t(M['commerce.select.clear'], { label: fieldLabel }),
);

function statusLabel(status: string): string {
  if (status === 'active') return t(M['commerce.party.status_active']);
  if (status === 'inactive') return t(M['commerce.party.status_inactive']);
  if (status === 'suspended') return t(M['commerce.party.status_suspended']);
  return status;
}

function typeLabel(type: string): string {
  if (type === 'dtc') return t(M['commerce.customer.type_dtc']);
  if (type === 'wholesale') return t(M['commerce.customer.type_wholesale']);
  if (type === 'retail') return t(M['commerce.customer.type_retail']);
  return type;
}

/** A party as a list row: the profile name, with status (and type) beneath. */
function toOption(party: CustomerDisplayData | VendorDisplayData): Option {
  const type = 'customerType' in party ? party.customerType : undefined;
  const detail = [
    party.status ? statusLabel(party.status) : '',
    type ? typeLabel(type) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    id: party.id,
    label: party.profile.name,
    ...(detail ? { detail } : {}),
  };
}

const options = $derived(
  results.map((item) => ({ value: item.id, label: item.label })),
);
const detailById = $derived(
  new Map(results.map((item) => [item.id, item.detail])),
);
const status = $derived(
  loading
    ? t(M['commerce.select.searching'])
    : failed
      ? t(M['commerce.select.search_failed'])
      : results.length === 0
        ? t(M['commerce.select.no_matches'])
        : t(
            results.length === 1
              ? M['commerce.select.results_one']
              : M['commerce.select.results_other'],
            { count: results.length },
          ),
);
const describedby = $derived(
  [error ? errorId : '', description ? hintId : ''].filter(Boolean).join(' ') ||
    undefined,
);
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name),
);
const canClear = $derived(!required && !disabled && value !== '');

async function runSearch(query: string) {
  const seq = ++searchSeq;
  loading = true;
  failed = false;
  try {
    const found = await search(query);
    if (seq !== searchSeq) return;
    results = found.map(toOption);
  } catch {
    if (seq !== searchSeq) return;
    results = [];
    failed = true;
  } finally {
    if (seq === searchSeq) loading = false;
  }
}

function handleQuery(query: string) {
  clearTimeout(timer);
  lastQuery = query;
  if (query === '') {
    void runSearch('');
    return;
  }
  // Drop any in-flight older request: listed rows answered an older query, so
  // none stay selectable until the new results arrive.
  searchSeq++;
  loading = true;
  failed = false;
  results = [];
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

/** A change the person made: tell agents and the enclosing form. */
function announceEdit() {
  recordControlUserEdit(
    interactionContext,
    controlId,
    interaction === false ? undefined : interaction?.subject,
  );
  if (rootEl) emitControlChange(rootEl);
}

function clear() {
  if (!canClear) return;
  value = '';
  selectedLabel = '';
  labelledId = '';
  lastQuery = '';
  onchange?.('');
  announceEdit();
  rootEl?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus();
}

async function create() {
  if (!onCreate || creating || disabled) return;
  const typed = lastQuery;
  creating = true;
  try {
    const made = await onCreate(typed);
    if (made && typeof made === 'object') {
      const option = toOption(made);
      results = [option, ...results.filter((item) => item.id !== option.id)];
      selectedLabel = option.label;
      labelledId = option.id;
      value = option.id;
      onchange?.(option.id);
      announceEdit();
    }
  } catch {
    // The caller owns creation and its error reporting; the field keeps its value.
  } finally {
    creating = false;
  }
}

// Keep the visible name in step with `value` however it changed (initial
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
    // A different id than the one labelled: never keep the previous name.
    selectedLabel = '';
    labelledId = '';
    if (!resolve || resolvingId === id) return;
    resolvingId = id;
    resolve(id)
      .then((party) => {
        if (value === id && party) {
          selectedLabel = party.profile.name;
          labelledId = id;
        }
      })
      .catch(() => {
        // An unresolved id leaves the field blank; the id still posts.
      })
      .finally(() => {
        if (resolvingId === id) resolvingId = '';
      });
  });
});

$effect(() => () => clearTimeout(timer));
</script>

<div class="party-select" bind:this={rootEl}>
  <div class="field">
    <Combobox
      {name}
      label={fieldLabel}
      {options}
      placeholder={fieldPlaceholder}
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
      <Button variant="ghost" size="sm" class="clear" aria-label={clearName} onclick={clear}>
        &times;
      </Button>
    {/if}
  </div>
  {#if description}<p id={hintId} class="hint">{description}</p>{/if}
  {#if onCreate}
    <Button variant="ghost" size="sm" class="create" disabled={disabled || creating} onclick={create}>
      + {newLabel}
    </Button>
  {/if}
  {#if error}<p id={errorId} class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .party-select {
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
    overflow-wrap: anywhere;
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
