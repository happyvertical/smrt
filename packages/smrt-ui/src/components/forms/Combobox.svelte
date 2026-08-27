<script lang="ts">
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
import { useControlRegistration } from './use-control-registration.svelte.js';
export interface Props {
  options: ControlOption[];
  value?: string;
  label: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  allowCustom?: boolean;
  interaction?: ControlInteractionOptions | false;
  onvaluechange?: (value: string) => void;
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
let query = $state(value);
let activeIndex = $state(0);
const filtered = $derived(
  options.filter((option) =>
    option.label.toLowerCase().includes(query.toLowerCase()),
  ),
);
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name ?? inputId),
);
function commit(option: ControlOption, userEdit = false) {
  if (option.disabled || disabled) return;
  const changed = String(option.value) !== value;
  value = String(option.value);
  query = option.label;
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
function handleInput(event: Event & { currentTarget: HTMLInputElement }) {
  query = event.currentTarget.value;
  open = true;
  activeIndex = 0;
  if (allowCustom) {
    value = query;
    onvaluechange?.(value);
  }
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    open = true;
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
    open = false;
  }
}
$effect(() => {
  if (!open) return;
  const dismissPointer = (event: PointerEvent) => {
    if (rootEl && !rootEl.contains(event.target as Node)) open = false;
  };
  const dismissFocus = (event: FocusEvent) => {
    if (rootEl && !rootEl.contains(event.target as Node)) open = false;
  };
  document.addEventListener('pointerdown', dismissPointer, true);
  document.addEventListener('focusin', dismissFocus, true);
  return () => {
    document.removeEventListener('pointerdown', dismissPointer, true);
    document.removeEventListener('focusin', dismissFocus, true);
  };
});
$effect(() => {
  const option = options.find((item) => String(item.value) === value);
  if (option && document.activeElement !== inputEl) query = option.label;
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
  <label for={inputId}>{label}</label><input bind:this={inputEl} id={inputId} {name} role="combobox" autocomplete="off" {placeholder} {disabled} {required} value={query}
    aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && filtered[activeIndex] ? `${listId}-${activeIndex}` : undefined}
    onfocus={() => open = true} oninput={handleInput} onkeydown={handleKeydown} />
  {#if open && filtered.length}<div id={listId} class="options" role="listbox">{#each filtered as option, index (option.value)}<button id={`${listId}-${index}`} type="button" role="option"
      aria-selected={String(option.value) === value} class:active={index === activeIndex} disabled={option.disabled} onpointerdown={(event) => event.preventDefault()} onclick={() => commit(option, true)}>{option.label}</button>{/each}</div>{/if}
</div>
<style>
  .combobox { position: relative; display: grid; gap: var(--smrt-spacing-1); color: var(--smrt-color-on-surface); }
  label { font: var(--smrt-typography-label-large-font); } input { width: 100%; padding: var(--smrt-spacing-2) var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface); color: inherit; }
  input:focus { outline: 2px solid var(--smrt-color-primary); outline-offset: 1px; } .options { position: absolute; z-index: var(--smrt-z-index-dropdown); top: 100%; left: 0; right: 0; display: grid; padding: var(--smrt-spacing-1); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface-container); box-shadow: var(--smrt-elevation-2); }
  .options button { padding: var(--smrt-spacing-2) var(--smrt-spacing-3); border: 0; border-radius: var(--smrt-radius-extra-small); background: transparent; color: var(--smrt-color-on-surface); text-align: left; } .options button.active { background: var(--smrt-color-secondary-container); }
  :global(.combobox[data-smrt-highlighted='true']) { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; }
</style>
