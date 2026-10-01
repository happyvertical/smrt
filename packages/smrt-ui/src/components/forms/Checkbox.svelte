<script lang="ts">
import type { HTMLInputAttributes } from 'svelte/elements';
import {
  emitControlChange,
  highlightControl,
  revealControl,
} from './control-dom.js';
import type { ControlInteractionOptions } from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import {
  booleanControlValue,
  prepareBooleanControlValue,
  validateNativeCheckedValue,
} from './control-value-validation.js';
import { tryGetFormGroupContext } from './form-group-context.js';
import { useControlRegistration } from './use-control-registration.svelte.js';

export interface Props
  extends Omit<HTMLInputAttributes, 'type' | 'class' | 'checked'> {
  /** Whether the checkbox is checked (bindable). */
  checked?: boolean;
  /** Whether the checkbox shows indeterminate state. */
  indeterminate?: boolean;
  /** Text label displayed next to the checkbox. */
  label?: string;
  /** CSS class to apply to the checkbox container. */
  class?: string;
  /** Interaction options or false to disable all. */
  interaction?: ControlInteractionOptions | false;
}

let {
  checked = $bindable(false),
  indeterminate = false,
  label,
  id,
  name,
  value,
  disabled = false,
  required = false,
  class: className = '',
  interaction,
  onchange,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedby,
  ...rest
}: Props = $props();

const instanceId = $props.id();
const formGroup = tryGetFormGroupContext();
const interactionContext = tryGetControlInteractionContext();
let inputEl = $state<HTMLInputElement | null>(null);
const resolvedId = $derived(
  id ?? formGroup?.().inputId ?? `smrt-checkbox-${instanceId}`,
);
const resolvedDescription = $derived(
  ariaDescribedby ?? formGroup?.().describedBy,
);
const resolvedInteraction = $derived.by(() => {
  const inherited = formGroup?.().interaction;
  if (interaction === false || inherited === false) return false;
  return { ...(inherited ?? {}), ...(interaction ?? {}) };
});
const controlId = $derived(
  resolvedInteraction === false
    ? undefined
    : (resolvedInteraction.id ?? name ?? resolvedId),
);

$effect(() => {
  if (inputEl) inputEl.indeterminate = indeterminate;
});

function setChecked(next: unknown) {
  checked = booleanControlValue(next);
  if (inputEl) emitControlChange(inputEl);
}

function handleChange(event: Event & { currentTarget: HTMLInputElement }) {
  checked = event.currentTarget.checked;
  onchange?.(event);
}

useControlRegistration(() => {
  const element = inputEl;
  const options = resolvedInteraction;
  if (!element || options === false) return false;
  return {
    controlId,
    subject: options.subject,
    metadata: {
      kind: 'checkbox',
      label: formGroup?.().label ?? label ?? ariaLabel ?? undefined,
      description: options.description ?? formGroup?.().description,
      sensitivity: options.sensitivity ?? 'public',
      readable: options.readable,
      writable: options.writable,
      constraints: { required: required === true },
    },
    getValue: () => checked,
    prepareValue: prepareBooleanControlValue,
    setValue: setChecked,
    clear: () => {
      setChecked(false);
      return true;
    },
    focus: () => element.focus(),
    reveal: () => revealControl(element),
    highlight: (durationMs) =>
      highlightControl(element.closest('label') ?? element, durationMs),
    validate: () => element.reportValidity(),
    validateValue: (next) => validateNativeCheckedValue(element, next),
    getState: () => ({
      disabled: element.matches(':disabled'),
      readonly: false,
      valid: element.validity.valid,
      validationMessage: element.validationMessage || undefined,
    }),
  };
});
</script>

<label
  class="checkbox {className}"
  class:checkbox--disabled={disabled}
  data-smrt-hit-target
  data-smrt-control={controlId}
  data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.type}
  data-smrt-subject-id={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.id}
>
  <input
    bind:this={inputEl}
    id={resolvedId}
    type="checkbox"
    {name}
    {value}
    {disabled}
    {required}
    checked={checked}
    aria-label={ariaLabel ?? (!label && !formGroup ? 'Checkbox' : undefined)}
    aria-describedby={resolvedDescription}
    aria-invalid={formGroup?.().invalid ? 'true' : undefined}
    onchange={handleChange}
    {...rest}
  />
  <span class="checkbox__box" aria-hidden="true">
    {#if indeterminate}<span class="checkbox__dash"></span>{:else if checked}<span class="checkbox__check">✓</span>{/if}
  </span>
  {#if label}<span class="checkbox__label">{label}</span>{/if}
</label>

<style>
  /* The visible box stays 18px. A transparent 44x44 hit area (WCAG 2.5.8 / M3 touch target) is
     centred on it with ::before, so clicks nearby still land on the wrapping <label>. It adds no
     layout. The box and the label text sit above every hit area (z-index 1 over 0), so a hit area
     never steals a click from a neighbour's visible box or text. Resize it with
     --smrt-control-hit-size (0px turns it off). */
  .checkbox { --_box: 1.125rem; --_hit: max(var(--smrt-control-hit-size, 2.75rem), var(--_box)); position: relative; display: inline-flex; align-items: center; gap: var(--smrt-spacing-2, .5rem); cursor: pointer; color: var(--smrt-color-on-surface); }
  .checkbox::before { content: ''; position: absolute; z-index: 0; inset-block-start: 50%; inset-inline-start: calc(var(--_box) / 2); inline-size: var(--_hit); block-size: var(--_hit); margin-block-start: calc(var(--_hit) / -2); margin-inline-start: calc(var(--_hit) / -2); }
  .checkbox--disabled { opacity: .5; cursor: not-allowed; }
  input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .checkbox__box { position: relative; z-index: 1; width: 1.125rem; height: 1.125rem; display: grid; place-items: center; border: 2px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-extra-small, 3px); background: var(--smrt-color-surface); transition: background var(--smrt-duration-short2), border-color var(--smrt-duration-short2); }
  .checkbox__label { position: relative; z-index: 1; }
  input:checked + .checkbox__box, input:indeterminate + .checkbox__box { background: var(--smrt-color-primary); border-color: var(--smrt-color-primary); color: var(--smrt-color-on-primary); }
  input:focus-visible + .checkbox__box { outline: 2px solid var(--smrt-color-primary); outline-offset: 3px; }
  .checkbox__check { font-size: .8rem; font-weight: 800; line-height: 1; }
  .checkbox__dash { width: .6rem; height: 2px; background: currentColor; }
  .checkbox[data-smrt-highlighted='true'] { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; border-radius: var(--smrt-radius-small); }

  /* Table cells: neighbouring cells hold links and other controls, so the hit area never leaves
     the cell's column. It grows vertically only (box wide)... */
  :global(:is(td, th)) .checkbox::before { inline-size: var(--_box); margin-inline-start: calc(var(--_box) / -2); }
  /* ...unless the checkbox is the cell's only content: then the whole cell, clipped to its own
     edges, is the hit area (the 44px target the header and every row share). */
  :global(:is(td, th):has(> [data-smrt-hit-target]:only-child)) { position: relative; }
  :global(:is(td, th):has(> [data-smrt-hit-target]:only-child)) > .checkbox { position: static; }
  :global(:is(td, th):has(> [data-smrt-hit-target]:only-child)) > .checkbox::before { inset: 0; inline-size: auto; block-size: auto; margin: 0; }

  @media (prefers-reduced-motion: reduce) { .checkbox__box { transition: none; } }
</style>
