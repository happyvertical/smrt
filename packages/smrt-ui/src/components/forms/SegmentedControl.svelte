<script lang="ts">
import { tick, untrack } from 'svelte';
import {
  emitControlChange,
  highlightControl,
  revealControl,
} from './control-dom.js';
import type { ControlInteractionOptions } from './control-interaction.js';
import {
  recordControlUserEdit,
  tryGetControlInteractionContext,
} from './control-interaction-context.js';
import {
  prepareEnabledOptionValue,
  validatesEnabledOption,
} from './control-value-validation.js';
import type { SegmentedControlOption } from './types.js';
import { useControlRegistration } from './use-control-registration.svelte.js';
export interface Props {
  /** Target density; omit to inherit the ThemeProvider setting. */
  density?: 'comfortable' | 'touch';
  /** The available segments and their values. */
  options: SegmentedControlOption[];
  /** The currently selected option value. */
  value?: string | number;
  /** Accessibility label for the control. */
  label: string;
  /** Form field identifier. */
  name?: string;
  /** Requires an enabled option to be selected before native form submission. */
  required?: boolean;
  /** Blocks interaction and submission of this control. */
  disabled?: boolean;
  /** Makes the control stretch to full container width. */
  fullWidth?: boolean;
  /** Registers this control for agent interaction; omit or pass false to exclude. */
  interaction?: ControlInteractionOptions | false;
  /** Fired when the selected segment changes. */
  onvaluechange?: (value: string | number) => void;
  /** Additional CSS class names. */
  class?: string;
}
let {
  options,
  value = $bindable(),
  label,
  name,
  required = false,
  disabled = false,
  fullWidth = false,
  interaction,
  onvaluechange,
  class: className = '',
  density,
}: Props = $props();
const instanceId = $props.id();
const initialValue = untrack(() => value);
const selectedOption = $derived(
  options.find((option) => option.value === value && !option.disabled),
);
const firstEnabledOption = $derived(options.find((option) => !option.disabled));
const validationOption = $derived(selectedOption ?? firstEnabledOption);
// Required nameless radio groups need explicit validity in browsers, while
// remaining unnamed so native FormData never receives a generated field.
$effect(() => {
  rootEl
    ?.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    .forEach((input) => {
      input.setCustomValidity(
        !name &&
          required &&
          !selectedOption &&
          options[Number(input.dataset.optionIndex)] === validationOption
          ? 'Please select an option.'
          : '',
      );
    });
});
function initializeRadio(
  node: HTMLInputElement,
  option: SegmentedControlOption,
) {
  node.defaultChecked = initialValue === option.value && !option.disabled;
}
function handleKeydown(event: KeyboardEvent) {
  if (
    !(event.target instanceof HTMLInputElement) ||
    event.target.matches(':disabled')
  )
    return;
  const radios = Array.from(
    rootEl?.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]:not(:disabled)',
    ) ?? [],
  );
  const index = radios.indexOf(event.target);
  let next: number;
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = (index + 1) % radios.length;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = (index - 1 + radios.length) % radios.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = radios.length - 1;
      break;
    default:
      return;
  }
  const radio = radios[next];
  if (!radio) return;
  event.preventDefault();
  radio.focus();
  setValue(options[Number(radio.dataset.optionIndex)].value, true);
}
$effect(() => {
  const root = rootEl;
  if (!root) return;
  let form: HTMLFormElement | null = null;
  let disposed = false;
  const reset = (event: Event) => {
    const valueAtDispatch = value;
    // Native event dispatch may checkpoint microtasks between listeners; wait
    // for the next task so a later form listener can still cancel the reset.
    setTimeout(async () => {
      if (
        event.defaultPrevented ||
        !rootEl?.isConnected ||
        !Object.is(value, valueAtDispatch)
      )
        return;
      const resetOption = options.find(
        (option) => option.value === initialValue && !option.disabled,
      );
      value = resetOption?.value;
      recordControlUserEdit(
        interactionContext,
        controlId,
        interaction === false ? undefined : interaction?.subject,
      );
      await tick();
      // A canceled reset never reaches this reconciliation; unchanged bound values
      // still need checked properties restored after the browser's native reset.
      rootEl
        ?.querySelectorAll<HTMLInputElement>('input[type="radio"]')
        .forEach((input) => {
          input.checked =
            options[Number(input.dataset.optionIndex)]?.value === value &&
            !input.disabled;
        });
    });
  };
  // Parent form ancestry is complete after the mount flush, including in SSR hydration.
  tick().then(() => {
    if (disposed) return;
    form = root.closest('form');
    form?.addEventListener('reset', reset);
  });
  return () => {
    disposed = true;
    form?.removeEventListener('reset', reset);
  };
});
const interactionContext = tryGetControlInteractionContext();
let rootEl = $state<HTMLDivElement | null>(null);
const controlId = $derived(
  interaction === false
    ? undefined
    : (interaction?.id ?? name ?? `segment-${instanceId}`),
);
function setValue(next: unknown, userEdit = false, emitChange = true) {
  const option = options.find((item) => String(item.value) === String(next));
  if (!option || option.disabled) return;
  const changed = !Object.is(value, option.value);
  value = option.value;
  onvaluechange?.(option.value);
  if (userEdit && changed) {
    recordControlUserEdit(
      interactionContext,
      controlId,
      interaction === false ? undefined : interaction?.subject,
    );
    if (rootEl && emitChange) emitControlChange(rootEl);
  }
}
useControlRegistration(() => {
  const root = rootEl;
  if (!root || interaction === false) return false;
  return {
    controlId,
    subject: interaction?.subject,
    metadata: {
      kind: 'segmented-control',
      label,
      description: interaction?.description,
      sensitivity: interaction?.sensitivity ?? 'public',
      readable: interaction?.readable,
      writable: interaction?.writable,
      options,
      constraints: { required },
    },
    getValue: () => value,
    prepareValue: (next) => prepareEnabledOptionValue(options, next),
    setValue,
    clear: () => {
      value = undefined;
      return true;
    },
    focus: () =>
      root
        .querySelector<HTMLElement>('input[type="radio"]:not(:disabled)')
        ?.focus(),
    reveal: () => revealControl(root),
    highlight: (durationMs) => highlightControl(root, durationMs),
    validate: () =>
      root
        .querySelector<HTMLInputElement>('input[type="radio"]:not(:disabled)')
        ?.reportValidity() ?? true,
    validateValue: (next) => validatesEnabledOption(options, next),
    getState: () => ({
      disabled: disabled || root.closest('fieldset:disabled') !== null,
      valid:
        !required ||
        !!selectedOption ||
        disabled ||
        root.closest('fieldset:disabled') !== null,
    }),
  };
});
</script>
<div bind:this={rootEl} data-density={density} class="segmented {className}" class:full-width={fullWidth} role="radiogroup" aria-label={label} aria-required={required} onkeydown={handleKeydown} data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={interaction === false ? undefined : interaction?.subject?.type}
  data-smrt-subject-id={interaction === false ? undefined : interaction?.subject?.id}>
  {#each options as option, index (option.value)}
    <label class:selected={selectedOption === option} class:disabled={disabled || option.disabled}>
      <input type="radio" {name} value={option.value} disabled={disabled || option.disabled}
        required={required && validationOption === option} aria-label={option.label}
        checked={selectedOption === option} aria-checked={selectedOption === option}
        tabindex={selectedOption === option || (!selectedOption && firstEnabledOption === option) ? 0 : -1}
        data-option-index={index} use:initializeRadio={option}
        onchange={() => setValue(option.value, true, false)} />
      <span>{option.label}</span>
    </label>
  {/each}
</div>
<style>
  .segmented { display: inline-flex; border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-full); overflow: hidden; }
  .segmented.full-width { display: flex; width: 100%; }
  label { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: 1; min-height: 2.5rem; padding: 0 var(--smrt-spacing-4); border: 0; border-right: 1px solid var(--smrt-color-outline); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); cursor: pointer; }
  label:last-child { border-right: 0; } label.selected { background: var(--smrt-color-secondary-container); color: var(--smrt-color-on-secondary-container); }
  label:has(input:focus-visible) { outline: 2px solid var(--smrt-color-primary); outline-offset: -3px; } label.disabled, label:has(input:disabled) { opacity: .5; cursor: not-allowed; }
  :global(.segmented[data-smrt-highlighted='true']) { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; }

  .segmented[data-density='touch'] { --smrt-control-target-min: var(--smrt-touch-target-min, 48px); }
  .segmented[data-density='comfortable'] { --smrt-control-target-min: 0px; }
  label { min-height: max(2.5rem, var(--smrt-control-target-min, 0px)); min-width: var(--smrt-control-target-min, 0px); }
  input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: inherit; }
</style>
