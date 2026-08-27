<script lang="ts">
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
import { validatesEnabledOption } from './control-value-validation.js';
import type { SegmentedControlOption } from './types.js';
import { useControlRegistration } from './use-control-registration.svelte.js';
export interface Props {
  options: SegmentedControlOption[];
  value?: string | number;
  label: string;
  name?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  interaction?: ControlInteractionOptions | false;
  onvaluechange?: (value: string | number) => void;
  class?: string;
}
let {
  options,
  value = $bindable(),
  label,
  name,
  disabled = false,
  fullWidth = false,
  interaction,
  onvaluechange,
  class: className = '',
}: Props = $props();
const instanceId = $props.id();
const interactionContext = tryGetControlInteractionContext();
let rootEl = $state<HTMLDivElement | null>(null);
const controlId = $derived(
  interaction === false
    ? undefined
    : (interaction?.id ?? name ?? `segment-${instanceId}`),
);
function setValue(next: unknown, userEdit = false) {
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
    if (rootEl) emitControlChange(rootEl);
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
    },
    getValue: () => value,
    setValue,
    clear: () => {
      value = undefined;
      return true;
    },
    focus: () =>
      root
        .querySelector<HTMLElement>('[role="radio"]:not([disabled])')
        ?.focus(),
    reveal: () => revealControl(root),
    highlight: (durationMs) => highlightControl(root, durationMs),
    validateValue: (next) => validatesEnabledOption(options, next),
    getState: () => ({
      disabled: disabled || root.closest('fieldset:disabled') !== null,
    }),
  };
});
</script>
<div bind:this={rootEl} class="segmented {className}" class:full-width={fullWidth} role="radiogroup" aria-label={label} data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={interaction === false ? undefined : interaction?.subject?.type}
  data-smrt-subject-id={interaction === false ? undefined : interaction?.subject?.id}>
  {#each options as option (option.value)}
    <button type="button" role="radio" aria-checked={value === option.value} disabled={disabled || option.disabled}
      tabindex={value === option.value || (value === undefined && option === options[0]) ? 0 : -1}
      class:selected={value === option.value} onclick={() => setValue(option.value, true)}>{option.label}</button>
  {/each}
</div>
<style>
  .segmented { display: inline-flex; border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-full); overflow: hidden; }
  .segmented.full-width { display: flex; width: 100%; }
  button { flex: 1; min-height: 2.5rem; padding: 0 var(--smrt-spacing-4); border: 0; border-right: 1px solid var(--smrt-color-outline); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); cursor: pointer; }
  button:last-child { border-right: 0; } button.selected { background: var(--smrt-color-secondary-container); color: var(--smrt-color-on-secondary-container); }
  button:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: -3px; } button:disabled { opacity: .5; cursor: not-allowed; }
  :global(.segmented[data-smrt-highlighted='true']) { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; }
</style>
