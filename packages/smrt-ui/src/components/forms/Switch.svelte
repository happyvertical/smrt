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
  extends Omit<
    HTMLInputAttributes,
    'type' | 'class' | 'checked' | 'role' | 'size'
  > {
  checked?: boolean;
  label?: string;
  labelPosition?: 'left' | 'right';
  size?: 'sm' | 'md' | 'lg';
  class?: string;
  interaction?: ControlInteractionOptions | false;
}

let {
  checked = $bindable(false),
  label,
  labelPosition = 'right',
  size = 'md',
  id,
  name,
  value,
  disabled = false,
  required = false,
  class: className = '',
  interaction,
  onchange,
  'aria-label': ariaLabel,
  ...rest
}: Props = $props();
const instanceId = $props.id();
const formGroup = tryGetFormGroupContext();
const interactionContext = tryGetControlInteractionContext();
let inputEl = $state<HTMLInputElement | null>(null);
const resolvedId = $derived(
  id ?? formGroup?.().inputId ?? `smrt-switch-${instanceId}`,
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
      kind: 'switch',
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
      valid: element.validity.valid,
      validationMessage: element.validationMessage || undefined,
    }),
  };
});
</script>

<label class="switch switch--{size} {className}" class:switch--disabled={disabled} data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.type}
  data-smrt-subject-id={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.id}>
  {#if label && labelPosition === 'left'}<span>{label}</span>{/if}
  <span class="switch__control">
    <input bind:this={inputEl} id={resolvedId} type="checkbox" role="switch" {name} {value} {disabled} {required} checked={checked}
      aria-label={ariaLabel ?? label ?? formGroup?.().label} aria-describedby={formGroup?.().describedBy}
      aria-invalid={formGroup?.().invalid ? 'true' : undefined} onchange={handleChange} {...rest} />
    <span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span>
  </span>
  {#if label && labelPosition === 'right'}<span>{label}</span>{/if}
</label>

<style>
  .switch { display: inline-flex; align-items: center; gap: var(--smrt-spacing-2, .5rem); cursor: pointer; color: var(--smrt-color-on-surface); }
  .switch--disabled { opacity: .5; cursor: not-allowed; }
  .switch__control { position: relative; display: inline-flex; }
  input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .switch__track { width: 2.75rem; height: 1.5rem; padding: 2px; border-radius: var(--smrt-radius-full); background: var(--smrt-color-surface-container-highest); border: 1px solid var(--smrt-color-outline); transition: background var(--smrt-duration-short2); }
  .switch__thumb { display: block; width: 1.125rem; height: 1.125rem; border-radius: 50%; background: var(--smrt-color-outline); transition: transform var(--smrt-duration-short2), background var(--smrt-duration-short2); }
  input:checked + .switch__track { background: var(--smrt-color-primary); border-color: var(--smrt-color-primary); }
  input:checked + .switch__track .switch__thumb { transform: translateX(1.25rem); background: var(--smrt-color-on-primary); }
  input:focus-visible + .switch__track { outline: 2px solid var(--smrt-color-primary); outline-offset: 3px; }
  .switch--sm { font-size: .8rem; transform-origin: left center; }
  .switch--lg .switch__track { transform: scale(1.15); margin-inline: .2rem; }
  .switch[data-smrt-highlighted='true'] { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; border-radius: var(--smrt-radius-full); }
  @media (prefers-reduced-motion: reduce) { .switch__track, .switch__thumb { transition: none; } }
</style>
