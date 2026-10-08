<script lang="ts">
import { type Snippet, untrack } from 'svelte';
import {
  emitControlChange,
  highlightControl,
  revealControl,
} from './control-dom.js';
import type {
  ControlInteractionOptions,
  ControlOption,
} from './control-interaction.js';
import {
  recordControlUserEdit,
  tryGetControlInteractionContext,
} from './control-interaction-context.js';
import {
  matchingOption,
  prepareTextControlValue,
} from './control-value-validation.js';
import FieldLabel from './FieldLabel.svelte';
import { useControlRegistration } from './use-control-registration.svelte.js';
export interface Props {
  /** Array of options to select from. */
  options: ControlOption[];
  /** Currently selected option value (bindable). */
  value?: string;
  /** Label for the combobox control. */
  label: string;
  /** HTML form field name. */
  name?: string;
  /** Placeholder text shown when value is empty. */
  placeholder?: string;
  /** Whether the control is disabled. */
  disabled?: boolean;
  /** Whether the control is required. */
  required?: boolean;
  /** Whether users can enter values not in the options list. */
  allowCustom?: boolean;
  /** Interaction options or false to disable all. */
  interaction?: ControlInteractionOptions | false;
  /**
   * Label for `value` while its option is not in `options` yet (options load
   * asynchronously, or only the current record is known). Without it the
   * field stays empty rather than flashing the raw value (an id).
   */
  valueLabel?: string;
  /**
   * Whether typing filters `options` by label. Set `false` when the caller
   * supplies the matching options itself (server-side search via `onquery`),
   * so a result that matched on something other than its label stays listed.
   */
  filter?: boolean;
  /**
   * Called with the text to search for when the list opens (empty) and on
   * every keystroke. Pair with `filter={false}` and fresh `options`.
   */
  onquery?: (query: string) => void;
  /**
   * Message announced politely to assistive technology while the list is open
   * ("Searching…", "3 results", "No results"). It is also shown inside the
   * list while there are no options to list.
   */
  status?: string;
  /** Marks the combobox busy while options are being fetched. */
  busy?: boolean;
  /** Marks the field invalid (`aria-invalid`). */
  invalid?: boolean;
  /** Ids of elements describing the field (error text, hints). */
  describedby?: string;
  /** Custom content for one option row; defaults to the label. */
  optionContent?: Snippet<[ControlOption]>;
  /** Callback when the selected value changes. */
  onvaluechange?: (value: string) => void;
  /** CSS class to apply to the combobox container. */
  class?: string;
}
let {
  options,
  value = $bindable(''),
  label,
  name,
  placeholder,
  disabled = false,
  required = false,
  allowCustom = false,
  interaction,
  valueLabel,
  filter = true,
  onquery,
  status,
  busy = false,
  invalid = false,
  describedby,
  optionContent,
  onvaluechange,
  class: className = '',
}: Props = $props();
const instanceId = $props.id();
const inputId = `smrt-combobox-${instanceId}`;
const listId = `${inputId}-list`;
const interactionContext = tryGetControlInteractionContext();
let rootEl = $state<HTMLDivElement | null>(null);
let inputEl = $state<HTMLInputElement | null>(null);
let open = $state(false);
const initialValue = untrack(() => value);
/** The text for a value: its option's label, never a raw id (see valueLabel). */
function labelForValue(candidate: string): string {
  if (!candidate) return '';
  const option = options.find((item) => String(item.value) === candidate);
  if (option) return option.label;
  if (valueLabel) return valueLabel;
  return allowCustom ? candidate : '';
}
let query = $state(untrack(() => labelForValue(value)));
/** The person has typed since opening: only then does the list filter. */
let typed = $state(false);
let activeIndex = $state(0);
const filtered = $derived(
  typed && filter
    ? options.filter((option) =>
        option.label.toLowerCase().includes(query.toLowerCase()),
      )
    : options,
);
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name ?? inputId),
);
function commit(option: ControlOption, userEdit = false) {
  if (option.disabled || disabled) return;
  const changed = String(option.value) !== value;
  value = String(option.value);
  query = option.label;
  typed = false;
  open = false;
  onvaluechange?.(value);
  if (userEdit && changed) {
    recordControlUserEdit(
      interactionContext,
      controlId,
      interaction === false ? undefined : interaction?.subject,
    );
    if (rootEl) emitControlChange(rootEl);
  }
}
function setValue(next: unknown) {
  const candidate = String(next ?? '');
  const option = matchingOption(options, candidate, true);
  if (option) commit(option);
  else if (allowCustom) {
    value = candidate;
    query = candidate;
    typed = false;
    onvaluechange?.(candidate);
  }
}
function prepareValue(next: unknown) {
  const candidate = prepareTextControlValue(next);
  const option = matchingOption(options, candidate, true);
  if (option) return String(option.value);
  if (allowCustom) return candidate;
  return candidate;
}
function openList() {
  if (open) return;
  open = true;
  // Reopening shows every option, starting at the current choice.
  typed = false;
  const selected = options.findIndex(
    (option) => String(option.value) === value,
  );
  activeIndex = selected >= 0 ? selected : 0;
  onquery?.('');
}
function closeList() {
  open = false;
  // Leaving without choosing puts the chosen label back.
  typed = false;
}
function handleInput(event: Event & { currentTarget: HTMLInputElement }) {
  query = event.currentTarget.value;
  typed = true;
  open = true;
  activeIndex = 0;
  onquery?.(query);
  if (allowCustom) {
    value = query;
    onvaluechange?.(value);
  }
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (!open) {
      openList();
      return;
    }
    const enabled = filtered
      .map((option, index) => (option.disabled ? -1 : index))
      .filter((index) => index >= 0);
    const position = enabled.indexOf(activeIndex);
    activeIndex = enabled[(position + 1) % enabled.length] ?? 0;
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    const enabled = filtered
      .map((option, index) => (option.disabled ? -1 : index))
      .filter((index) => index >= 0);
    const position = enabled.indexOf(activeIndex);
    activeIndex =
      enabled[(position - 1 + enabled.length) % enabled.length] ?? 0;
  } else if (event.key === 'Enter' && open && filtered[activeIndex]) {
    event.preventDefault();
    commit(filtered[activeIndex], true);
  } else if (event.key === 'Escape') {
    closeList();
  }
}
// Options that arrive late can be fewer than the highlighted row.
$effect(() => {
  if (activeIndex >= filtered.length) activeIndex = 0;
});
$effect(() => {
  const form = inputEl?.form;
  if (!form) return;
  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const reset = (event: Event) => {
    const valueAtDispatch = value;
    const queryAtDispatch = query;
    // Native dispatch can checkpoint microtasks between reset listeners.
    // Wait for the next task so later cancellation and edits win.
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (
        disposed ||
        event.defaultPrevented ||
        value !== valueAtDispatch ||
        query !== queryAtDispatch
      )
        return;
      value = initialValue;
      query = labelForValue(initialValue);
      typed = false;
      open = false;
      recordControlUserEdit(
        interactionContext,
        controlId,
        interaction === false ? undefined : interaction?.subject,
      );
      onvaluechange?.(value);
    });
    timers.add(timer);
  };
  form.addEventListener('reset', reset);
  return () => {
    disposed = true;
    form.removeEventListener('reset', reset);
    for (const timer of timers) clearTimeout(timer);
  };
});
$effect(() => {
  if (!open) return;
  const dismissPointer = (event: PointerEvent) => {
    if (rootEl && !rootEl.contains(event.target as Node)) closeList();
  };
  const dismissFocus = (event: FocusEvent) => {
    if (rootEl && !rootEl.contains(event.target as Node)) closeList();
  };
  document.addEventListener('pointerdown', dismissPointer, true);
  document.addEventListener('focusin', dismissFocus, true);
  return () => {
    document.removeEventListener('pointerdown', dismissPointer, true);
    document.removeEventListener('focusin', dismissFocus, true);
  };
});
// Follow the value (and options that load later) unless the person is typing.
$effect(() => {
  const label = labelForValue(value);
  if (!typed) query = label;
});
// Validity follows the committed `value`, not the visible text: a value whose
// option has not loaded shows an empty field but is filled in, and text typed
// without choosing an option is not a value.
$effect(() => {
  if (!inputEl) return;
  inputEl.setCustomValidity(
    required && !disabled && !value && query.trim() !== ''
      ? 'Choose an option from the list.'
      : '',
  );
});
useControlRegistration(() => {
  const root = rootEl;
  const input = inputEl;
  if (!root || !input || interaction === false) return false;
  return {
    controlId,
    subject: interaction?.subject,
    metadata: {
      kind: 'combobox',
      label,
      description: interaction?.description,
      sensitivity: interaction?.sensitivity ?? 'public',
      readable: interaction?.readable,
      writable: interaction?.writable,
      constraints: { required },
      options,
    },
    getValue: () => value,
    prepareValue,
    setValue,
    clear: () => {
      value = '';
      query = '';
      onvaluechange?.('');
      return true;
    },
    focus: () => input.focus(),
    reveal: () => revealControl(root),
    highlight: (durationMs) => highlightControl(root, durationMs),
    validate: () => input.reportValidity(),
    validateValue: (next) => {
      const candidate = String(next ?? '');
      const option = matchingOption(options, candidate, true);
      if (option) return option.disabled !== true;
      return allowCustom && (!required || candidate.length > 0);
    },
    getState: () => ({
      disabled: input.matches(':disabled'),
      valid: input.validity.valid,
      validationMessage: input.validationMessage || undefined,
    }),
  };
});
</script>
<div bind:this={rootEl} class="combobox {className}" data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={interaction === false ? undefined : interaction?.subject?.type}
  data-smrt-subject-id={interaction === false ? undefined : interaction?.subject?.id}>
  <FieldLabel for={inputId} {label} {required} />
  <!-- The form posts the committed value (an option id), never the label the person sees. -->
  {#if name}<input type="hidden" {name} {value} {disabled} />{/if}
  <input bind:this={inputEl} id={inputId} role="combobox" autocomplete="off" {placeholder} {disabled} required={required && !value} aria-required={required ? 'true' : undefined} value={query}
    aria-expanded={open} aria-controls={listId} aria-busy={busy ? 'true' : undefined} aria-invalid={invalid ? 'true' : undefined} aria-describedby={describedby} aria-autocomplete="list" aria-activedescendant={open && filtered[activeIndex] ? `${listId}-${activeIndex}` : undefined}
    onfocus={openList} onclick={openList} oninput={handleInput} onkeydown={handleKeydown} />
  {#if open && filtered.length}<div id={listId} class="options" role="listbox">{#each filtered as option, index (option.value)}<button id={`${listId}-${index}`} type="button" role="option"
      aria-selected={String(option.value) === value} class:active={index === activeIndex} disabled={option.disabled} onpointerdown={(event) => event.preventDefault()} onclick={() => commit(option, true)}>{#if optionContent}{@render optionContent(option)}{:else}{option.label}{/if}</button>{/each}</div>
  {:else if open && status}<div class="options empty" aria-hidden="true">{status}</div>{/if}
  {#if status !== undefined}<div class="sr-status" role="status" aria-live="polite">{open ? status : ''}</div>{/if}
</div>
<style>
  .combobox { position: relative; display: grid; gap: 0; color: var(--smrt-color-on-surface); }
  input { box-sizing: border-box; width: 100%; padding: var(--smrt-spacing-2) var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface); color: inherit; }
  input:focus { outline: 2px solid var(--smrt-color-primary); outline-offset: 1px; } .options { position: absolute; z-index: var(--smrt-z-index-dropdown); top: 100%; left: 0; right: 0; display: grid; padding: var(--smrt-spacing-1); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface-container); box-shadow: var(--smrt-elevation-2); }
  .options button { padding: var(--smrt-spacing-2) var(--smrt-spacing-3); border: 0; border-radius: var(--smrt-radius-extra-small); background: transparent; color: var(--smrt-color-on-surface); text-align: left; } .options button.active { background: var(--smrt-color-secondary-container); }
  .options.empty { padding: var(--smrt-spacing-2) var(--smrt-spacing-3); color: var(--smrt-color-on-surface-variant); }
  .sr-status { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  :global(.combobox[data-smrt-highlighted='true']) { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; }
</style>
