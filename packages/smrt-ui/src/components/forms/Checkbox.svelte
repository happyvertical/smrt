<script lang="ts">
import type { HTMLInputAttributes } from 'svelte/elements';
import {
  emitControlChange,
  highlightControl,
  revealControl,
} from './control-dom.js';
import type { ControlInteractionOptions } from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import { tryGetFormGroupContext } from './form-group-context.js';
import { useControlRegistration } from './use-control-registration.svelte.js';

export interface Props
  extends Omit<HTMLInputAttributes, 'type' | 'class' | 'checked'> {
  checked?: boolean;
  indeterminate?: boolean;
  label?: string;
  class?: string;
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
  checked =
    typeof next === 'string'
      ? ['true', '1', 'yes', 'on'].includes(next.toLowerCase())
      : Boolean(next);
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
  .checkbox { display: inline-flex; align-items: center; gap: var(--smrt-spacing-2, .5rem); cursor: pointer; color: var(--smrt-color-on-surface); }
  .checkbox--disabled { opacity: .5; cursor: not-allowed; }
  input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .checkbox__box { width: 1.125rem; height: 1.125rem; display: grid; place-items: center; border: 2px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-extra-small, 3px); background: var(--smrt-color-surface); transition: background var(--smrt-duration-short2), border-color var(--smrt-duration-short2); }
  input:checked + .checkbox__box, input:indeterminate + .checkbox__box { background: var(--smrt-color-primary); border-color: var(--smrt-color-primary); color: var(--smrt-color-on-primary); }
  input:focus-visible + .checkbox__box { outline: 2px solid var(--smrt-color-primary); outline-offset: 3px; }
  .checkbox__check { font-size: .8rem; font-weight: 800; line-height: 1; }
  .checkbox__dash { width: .6rem; height: 2px; background: currentColor; }
  .checkbox[data-smrt-highlighted='true'] { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; border-radius: var(--smrt-radius-small); }
  @media (prefers-reduced-motion: reduce) { .checkbox__box { transition: none; } }
</style>
