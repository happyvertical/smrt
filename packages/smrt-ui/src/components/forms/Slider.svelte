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
  extends Omit<
    HTMLInputAttributes,
    'type' | 'class' | 'value' | 'min' | 'max' | 'step'
  > {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  unit?: string;
  showInput?: boolean;
  formatValue?: (value: number) => string;
  class?: string;
  interaction?: ControlInteractionOptions | false;
}
let {
  value = $bindable(0),
  min = 0,
  max = 100,
  step = 1,
  label,
  unit,
  showInput = true,
  formatValue = (next) => `${next}${unit ?? ''}`,
  id,
  name,
  disabled = false,
  class: className = '',
  interaction,
  onchange,
  ...rest
}: Props = $props();
const instanceId = $props.id();
const formGroup = tryGetFormGroupContext();
const interactionContext = tryGetControlInteractionContext();
let rangeEl = $state<HTMLInputElement | null>(null);
const resolvedId = $derived(
  id ?? formGroup?.().inputId ?? `smrt-slider-${instanceId}`,
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
const percent = $derived(max === min ? 0 : ((value - min) / (max - min)) * 100);
function clamp(next: number) {
  return Math.min(max, Math.max(min, Math.round(next / step) * step));
}
function setValue(next: unknown) {
  const parsed = Number(next);
  if (!Number.isFinite(parsed)) return;
  value = clamp(parsed);
  if (rangeEl) emitControlChange(rangeEl);
}
function handleInput(event: Event & { currentTarget: HTMLInputElement }) {
  value = Number(event.currentTarget.value);
}
function handleChange(event: Event & { currentTarget: HTMLInputElement }) {
  value = Number(event.currentTarget.value);
  onchange?.(event);
}
useControlRegistration(() => {
  const element = rangeEl;
  const options = resolvedInteraction;
  if (!element || options === false) return false;
  return {
    controlId,
    subject: options.subject,
    metadata: {
      kind: 'slider',
      label: formGroup?.().label ?? label,
      description: options.description ?? formGroup?.().description,
      sensitivity: options.sensitivity ?? 'public',
      readable: options.readable,
      writable: options.writable,
      constraints: { min, max, step },
      unit,
    },
    getValue: () => value,
    setValue,
    clear: () => {
      setValue(min);
      return true;
    },
    focus: () => element.focus(),
    reveal: () => revealControl(element),
    highlight: (durationMs) =>
      highlightControl(element.closest('.slider') ?? element, durationMs),
    validate: () => element.reportValidity(),
    getState: () => ({
      disabled: element.matches(':disabled'),
      valid: element.validity.valid,
      validationMessage: element.validationMessage || undefined,
    }),
  };
});
</script>
<div class="slider {className}" data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.type}
  data-smrt-subject-id={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.id}>
  {#if label}<div class="slider__header"><label for={resolvedId}>{label}</label><output for={resolvedId}>{formatValue(value)}</output></div>{/if}
  <div class="slider__controls">
    <input bind:this={rangeEl} id={resolvedId} type="range" {name} {min} {max} {step} {disabled} value={value}
      style={`--smrt-slider-percent: ${percent}%`} aria-valuetext={formatValue(value)} aria-describedby={formGroup?.().describedBy}
      oninput={handleInput} onchange={handleChange} {...rest} />
    {#if showInput}<input class="slider__number" type="number" {min} {max} {step} {disabled} value={value}
      aria-label={label ? `${label} value` : 'Slider value'} onchange={(event) => setValue(event.currentTarget.value)} />{/if}
  </div>
</div>
<style>
  .slider { display: grid; gap: var(--smrt-spacing-2); color: var(--smrt-color-on-surface); }
  .slider__header, .slider__controls { display: flex; align-items: center; gap: var(--smrt-spacing-3); }
  .slider__header { justify-content: space-between; font: var(--smrt-typography-label-large-font); }
  output { color: var(--smrt-color-primary); font-variant-numeric: tabular-nums; }
  input[type='range'] { flex: 1; min-width: 8rem; accent-color: var(--smrt-color-primary); cursor: pointer; }
  .slider__number { width: 5.5rem; padding: var(--smrt-spacing-2); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); }
  input:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 3px; }
  .slider[data-smrt-highlighted='true'] { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; border-radius: var(--smrt-radius-small); }
</style>
