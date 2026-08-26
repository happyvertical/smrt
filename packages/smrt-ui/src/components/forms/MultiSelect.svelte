<script lang="ts">
import { tick } from 'svelte';
import { highlightControl, revealControl } from './control-dom.js';
import type {
  ControlInteractionOptions,
  ControlOption,
} from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import { useControlRegistration } from './use-control-registration.svelte.js';
export interface Props {
  options: ControlOption[];
  values?: Array<string | number>;
  label: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  interaction?: ControlInteractionOptions | false;
  onvalueschange?: (values: Array<string | number>) => void;
  class?: string;
}
let {
  options,
  values = $bindable([]),
  label,
  name,
  placeholder = 'Select options',
  disabled = false,
  interaction,
  onvalueschange,
  class: className = '',
}: Props = $props();
const instanceId = $props.id();
const listId = `smrt-multiselect-${instanceId}`;
const triggerId = `${listId}-trigger`;
const interactionContext = tryGetControlInteractionContext();
let rootEl = $state<HTMLDivElement | null>(null);
let triggerEl = $state<HTMLButtonElement | null>(null);
let optionEls = $state<Array<HTMLButtonElement | null>>([]);
let open = $state(false);
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name ?? listId),
);
const selectedLabels = $derived(
  options
    .filter((option) =>
      values.some((value) => String(value) === String(option.value)),
    )
    .map((option) => option.label),
);
function toggle(option: ControlOption) {
  if (option.disabled || disabled) return;
  const has = values.some((value) => String(value) === String(option.value));
  values = has
    ? values.filter((value) => String(value) !== String(option.value))
    : [...values, option.value];
  onvalueschange?.(values);
}
function setValues(next: unknown) {
  if (!Array.isArray(next)) return;
  values = options
    .filter(
      (option) =>
        next.some((value) => String(value) === String(option.value)) &&
        !option.disabled,
    )
    .map((option) => option.value);
  onvalueschange?.(values);
}
async function openOptions(focusFirst = false) {
  if (disabled) return;
  open = true;
  if (focusFirst) {
    await tick();
    optionEls.find((element) => element && !element.disabled)?.focus();
  }
}
function closeOptions(refocus = false) {
  open = false;
  if (refocus) triggerEl?.focus();
}
function handleTriggerKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    openOptions(true);
  } else if (event.key === 'Escape') {
    closeOptions();
  }
}
function handleOptionsKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeOptions(true);
    return;
  }
  if (event.key === 'Tab') {
    closeOptions();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const enabled = optionEls.filter(
    (element): element is HTMLButtonElement => !!element && !element.disabled,
  );
  if (enabled.length === 0) return;
  const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? enabled.length - 1
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) %
          enabled.length;
  enabled[next]?.focus();
}
$effect(() => {
  if (!open) return;
  const dismiss = (event: PointerEvent) => {
    if (rootEl && !rootEl.contains(event.target as Node)) closeOptions();
  };
  document.addEventListener('pointerdown', dismiss, true);
  return () => document.removeEventListener('pointerdown', dismiss, true);
});
useControlRegistration(() => {
  const root = rootEl;
  const trigger = triggerEl;
  if (!root || !trigger || interaction === false) return false;
  return {
    controlId,
    subject: interaction?.subject,
    metadata: {
      kind: 'multi-select',
      label,
      description: interaction?.description,
      sensitivity: interaction?.sensitivity ?? 'public',
      readable: interaction?.readable,
      writable: interaction?.writable,
      options,
    },
    getValue: () => [...values],
    setValue: setValues,
    clear: () => setValues([]),
    focus: () => trigger.focus(),
    reveal: () => revealControl(root),
    highlight: (durationMs) => highlightControl(root, durationMs),
    getState: () => ({ disabled }),
  };
});
</script>
<div bind:this={rootEl} class="multi-select {className}" data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={interaction === false ? undefined : interaction?.subject?.type}
  data-smrt-subject-id={interaction === false ? undefined : interaction?.subject?.id}>
  <span class="label" id={`${listId}-label`}>{label}</span><button bind:this={triggerEl} id={triggerId} type="button" class="trigger" {disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-labelledby={`${listId}-label ${triggerId}`} onclick={() => open ? closeOptions() : openOptions()} onkeydown={handleTriggerKeydown}>{selectedLabels.length ? selectedLabels.join(', ') : placeholder}</button>
  {#if open}<div id={listId} class="options" role="listbox" tabindex="-1" aria-multiselectable="true" aria-labelledby={`${listId}-label`} onkeydown={handleOptionsKeydown}>{#each options as option, index (option.value)}<button bind:this={optionEls[index]} type="button" role="option" tabindex="-1" aria-selected={values.some((value) => String(value) === String(option.value))} disabled={option.disabled} onclick={() => toggle(option)}><span aria-hidden="true">{values.some((value) => String(value) === String(option.value)) ? '✓' : ''}</span>{option.label}</button>{/each}</div>{/if}
</div>
<style>
  .multi-select { position: relative; display: grid; gap: var(--smrt-spacing-1); color: var(--smrt-color-on-surface); } .label { font: var(--smrt-typography-label-large-font); }
  .trigger { width: 100%; min-height: 2.5rem; padding: var(--smrt-spacing-2) var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface); color: inherit; text-align: left; }
  .options { position: absolute; z-index: var(--smrt-z-index-dropdown); top: 100%; left: 0; right: 0; display: grid; padding: var(--smrt-spacing-1); border: 1px solid var(--smrt-color-outline-variant); background: var(--smrt-color-surface-container); box-shadow: var(--smrt-elevation-2); }
  .options button { display: grid; grid-template-columns: 1.25rem 1fr; gap: var(--smrt-spacing-2); padding: var(--smrt-spacing-2); border: 0; background: transparent; color: inherit; text-align: left; } .options button[aria-selected='true'] { background: var(--smrt-color-secondary-container); }
  :global(.multi-select[data-smrt-highlighted='true']) { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; }
</style>
