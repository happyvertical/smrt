<script lang="ts">
import {
  emitControlChange,
  highlightControl,
  revealControl,
} from './control-dom.js';
import type { ControlInteractionOptions } from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import {
  snapSteppedNumber,
  validatesSteppedNumber,
} from './control-value-validation.js';
import { tryGetFormGroupContext } from './form-group-context.js';
import type { RangeSliderValue } from './types.js';
import { useControlRegistration } from './use-control-registration.svelte.js';
export interface Props {
  value?: RangeSliderValue;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  minLabel?: string;
  maxLabel?: string;
  unit?: string;
  disabled?: boolean;
  name?: string;
  interaction?: ControlInteractionOptions | false;
  onvaluechange?: (value: RangeSliderValue) => void;
  class?: string;
}
let {
  value = $bindable({ min: 25, max: 75 }),
  min = 0,
  max = 100,
  step = 1,
  label,
  minLabel = 'Minimum',
  maxLabel = 'Maximum',
  unit,
  disabled = false,
  name,
  interaction,
  onvaluechange,
  class: className = '',
}: Props = $props();
const instanceId = $props.id();
const formGroup = tryGetFormGroupContext();
const interactionContext = tryGetControlInteractionContext();
let rootEl = $state<HTMLDivElement | null>(null);
let minEl = $state<HTMLInputElement | null>(null);
let maxEl = $state<HTMLInputElement | null>(null);
const minId = `smrt-range-min-${instanceId}`;
const maxId = `smrt-range-max-${instanceId}`;
const resolvedInteraction = $derived.by(() => {
  const inherited = formGroup?.().interaction;
  if (interaction === false || inherited === false) return false;
  return { ...(inherited ?? {}), ...(interaction ?? {}) };
});
const controlId = $derived(
  resolvedInteraction === false
    ? undefined
    : (resolvedInteraction.id ??
        name ??
        formGroup?.().inputId ??
        `range-${instanceId}`),
);
function snap(next: number) {
  return snapSteppedNumber(next, min, max, step);
}
function validateRange(next: unknown) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
  const candidate = next as Record<string, unknown>;
  if (
    !Object.hasOwn(candidate, 'min') ||
    !Object.hasOwn(candidate, 'max') ||
    Object.keys(candidate).some((key) => key !== 'min' && key !== 'max')
  )
    return false;
  return (
    validatesSteppedNumber(candidate.min, min, max, step) &&
    validatesSteppedNumber(candidate.max, min, max, step) &&
    Number(candidate.min) <= Number(candidate.max)
  );
}
function setRange(next: unknown) {
  if (!next || typeof next !== 'object') return;
  const candidate = next as Partial<RangeSliderValue>;
  const low = snap(Number(candidate.min ?? value.min));
  const high = snap(Number(candidate.max ?? value.max));
  value = { min: Math.min(low, high), max: Math.max(low, high) };
  onvaluechange?.(value);
  if (rootEl) emitControlChange(rootEl);
}
function prepareRange(next: unknown): RangeSliderValue {
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw new Error('staged_value_invalid');
  }
  const candidate = next as Partial<RangeSliderValue>;
  if (
    (typeof candidate.min !== 'number' && typeof candidate.min !== 'string') ||
    (typeof candidate.max !== 'number' && typeof candidate.max !== 'string')
  ) {
    throw new Error('staged_value_invalid');
  }
  const prepared = { min: Number(candidate.min), max: Number(candidate.max) };
  if (!Number.isFinite(prepared.min) || !Number.isFinite(prepared.max)) {
    throw new Error('staged_value_invalid');
  }
  return {
    min: validatesSteppedNumber(prepared.min, min, max, step)
      ? snap(prepared.min)
      : prepared.min,
    max: validatesSteppedNumber(prepared.max, min, max, step)
      ? snap(prepared.max)
      : prepared.max,
  };
}
function setMin(next: number) {
  setRange({ min: Math.min(next, value.max), max: value.max });
}
function setMax(next: number) {
  setRange({ min: value.min, max: Math.max(next, value.min) });
}
useControlRegistration(() => {
  const root = rootEl;
  const options = resolvedInteraction;
  if (!root || options === false) return false;
  return {
    controlId,
    subject: options.subject,
    metadata: {
      kind: 'range-slider',
      label: formGroup?.().label ?? label,
      description: options.description ?? formGroup?.().description,
      sensitivity: options.sensitivity ?? 'public',
      readable: options.readable,
      writable: options.writable,
      constraints: { min, max, step },
      unit,
    },
    getValue: () => ({ ...value }),
    prepareValue: prepareRange,
    setValue: setRange,
    clear: () => {
      setRange({ min, max });
      return true;
    },
    focus: () => minEl?.focus(),
    reveal: () => revealControl(root),
    highlight: (durationMs) => highlightControl(root, durationMs),
    validate: () => value.min <= value.max,
    validateValue: validateRange,
    getState: () => ({
      disabled:
        disabled ||
        minEl?.matches(':disabled') === true ||
        maxEl?.matches(':disabled') === true,
      valid: value.min <= value.max,
    }),
  };
});
</script>
<div bind:this={rootEl} class="range-slider {className}" class:disabled data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.type}
  data-smrt-subject-id={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.id} role="group" aria-label={label ?? formGroup?.().label ?? 'Range'}>
  {#if label}<div class="range-slider__header"><span>{label}</span><output>{value.min}{unit ?? ''} – {value.max}{unit ?? ''}</output></div>{/if}
  <div class="range-slider__track">
    <input bind:this={minEl} id={minId} type="range" name={name ? `${name}[min]` : undefined} {min} max={value.max} {step} {disabled} value={value.min}
      aria-label={minLabel} aria-valuetext={`${value.min}${unit ?? ''}`} oninput={(event) => setMin(Number(event.currentTarget.value))} />
    <input bind:this={maxEl} id={maxId} type="range" name={name ? `${name}[max]` : undefined} min={value.min} {max} {step} {disabled} value={value.max}
      aria-label={maxLabel} aria-valuetext={`${value.max}${unit ?? ''}`} oninput={(event) => setMax(Number(event.currentTarget.value))} />
  </div>
  <div class="range-slider__inputs">
    <label for={`${minId}-number`}>{minLabel}<input id={`${minId}-number`} type="number" {min} max={value.max} {step} {disabled} value={value.min} onchange={(event) => setMin(Number(event.currentTarget.value))} /></label>
    <label for={`${maxId}-number`}>{maxLabel}<input id={`${maxId}-number`} type="number" min={value.min} {max} {step} {disabled} value={value.max} onchange={(event) => setMax(Number(event.currentTarget.value))} /></label>
  </div>
</div>
<style>
  .range-slider { display: grid; gap: var(--smrt-spacing-3); color: var(--smrt-color-on-surface); }
  .range-slider.disabled { opacity: .5; }
  .range-slider__header { display: flex; justify-content: space-between; font: var(--smrt-typography-label-large-font); }
  output { color: var(--smrt-color-primary); font-variant-numeric: tabular-nums; }
  .range-slider__track { position: relative; min-height: 1.75rem; display: grid; align-items: center; }
  .range-slider__track input { grid-area: 1 / 1; width: 100%; pointer-events: none; accent-color: var(--smrt-color-primary); background: transparent; }
  .range-slider__track input::-webkit-slider-thumb { pointer-events: auto; }
  .range-slider__track input::-moz-range-thumb { pointer-events: auto; }
  .range-slider__inputs { display: flex; gap: var(--smrt-spacing-3); }
  .range-slider__inputs label { display: grid; gap: var(--smrt-spacing-1); flex: 1; font: var(--smrt-typography-label-small-font); color: var(--smrt-color-on-surface-variant); }
  .range-slider__inputs input { width: 100%; padding: var(--smrt-spacing-2); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); }
  input:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 3px; }
  :global(.range-slider[data-smrt-highlighted='true']) { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; border-radius: var(--smrt-radius-small); }
</style>
