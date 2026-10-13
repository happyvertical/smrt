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
  /** Target density; omit to inherit the ThemeProvider setting. */
  density?: 'comfortable' | 'touch';
  /** Whether the switch is checked. */
  checked?: boolean;
  /** Text displayed next to the switch. */
  label?: string;
  /** Position of the label relative to the switch. */
  labelPosition?: 'left' | 'right';
  /** Visual size of the switch control. */
  size?: 'sm' | 'md' | 'lg';
  /** Additional CSS class names. */
  class?: string;
  /** Registers this control for agent interaction; omit or pass false to exclude. */
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
  density,
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

<label data-density={density} class="smrt-switch__root smrt-switch__{size} {className}" class:smrt-switch__disabled={disabled} data-smrt-hit-target data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.type}
  data-smrt-subject-id={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.id} data-smrt-component="Switch">
  {#if label && labelPosition === 'left'}<span class="smrt-switch__label" data-smrt-part="label">{label}</span>{/if}
  <span class="smrt-switch__control" data-smrt-part="control">
    <input bind:this={inputEl} id={resolvedId} type="checkbox" role="switch" {name} {value} {disabled} {required} checked={checked}
      aria-label={ariaLabel ?? label ?? formGroup?.().label} aria-describedby={formGroup?.().describedBy}
      aria-invalid={formGroup?.().invalid ? 'true' : undefined} onchange={handleChange} {...rest} data-smrt-part="input" />
    <span class="smrt-switch__track" data-smrt-part="track" aria-hidden="true"><span class="smrt-switch__thumb" data-smrt-part="thumb"></span></span>
  </span>
  {#if label && labelPosition === 'right'}<span class="smrt-switch__label" data-smrt-part="label">{label}</span>{/if}
</label>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  /* The 2.75rem-wide track gets a transparent 44px-tall ::before hit area (see Checkbox); the
     track and label sit above every hit area. --smrt-control-hit-size resizes it (0px = off). */
  .smrt-switch__root {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    cursor: pointer;
  }
  .smrt-switch__disabled {
    cursor: not-allowed;
  }
  @media (max-width: 48rem) {
    .smrt-switch__root {
      min-block-size: 2.75rem;
    }
  }
  .smrt-switch__control {
    --smrt-switch-hit: max(var(--smrt-control-hit-size, 2.75rem), 1.5rem);
    position: relative;
    display: inline-flex;
  }
  .smrt-switch__control::before {
    content: '';
    position: absolute;
    z-index: 0;
    inset-block-start: 50%;
    inset-inline: calc((100% - var(--smrt-switch-hit)) / 2);
    block-size: var(--smrt-switch-hit);
    margin-block-start: calc(var(--smrt-switch-hit) / -2);
  }
  .smrt-switch__label {
    position: relative;
    z-index: 1;
  }
  input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .smrt-switch__track {
    position: relative;
    z-index: 1;
    width: 2.75rem;
    height: 1.5rem;
    padding: 2px;
  }
  .smrt-switch__thumb {
    display: block;
    width: 1.125rem;
    height: 1.125rem;
  }
  input:checked + .smrt-switch__track .smrt-switch__thumb {
    transform: translateX(1.25rem);
  }
  .smrt-switch__sm {
    transform-origin: left center;
  }
  .smrt-switch__lg .smrt-switch__track {
    transform: scale(1.15);
    margin-inline: .2rem;
  }
  .smrt-switch__root[data-density='touch'] {
    --smrt-switch-target-min: var(--smrt-touch-target-min);
  }
  .smrt-switch__root[data-density='comfortable'] {
    --smrt-switch-target-min: 0px;
  }
  .smrt-switch__root {
    min-height: var(--smrt-switch-target-min, var(--smrt-control-target-min));
    min-width: var(--smrt-switch-target-min, var(--smrt-control-target-min));
  }
}
@layer smrt.theme {
  .smrt-switch__root {
    color: var(--smrt-color-on-surface);
  }
  .smrt-switch__disabled {
    opacity: .5;
  }
  .smrt-switch__track {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface-container-highest);
    border: var(--smrt-hairline-strong);
    transition: background var(--smrt-duration-short2);
  }
  .smrt-switch__thumb {
    border-radius: 50%;
    background: var(--smrt-color-outline);
    transition: transform var(--smrt-duration-short2), background var(--smrt-duration-short2);
  }
  input:checked + .smrt-switch__track {
    background: var(--smrt-color-primary);
    border-color: var(--smrt-color-primary);
  }
  input:checked + .smrt-switch__track .smrt-switch__thumb {
    background: var(--smrt-color-on-primary);
  }
  input:focus-visible + .smrt-switch__track {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .smrt-switch__sm {
    font-size: .8rem;
  }
  .smrt-switch__root[data-smrt-highlighted='true'] {
    outline: 3px solid var(--smrt-color-tertiary);
    outline-offset: 4px;
    border-radius: var(--smrt-radius-full);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-switch__track, .smrt-switch__thumb {
      transition: none;
    }
  }
}
</style>
