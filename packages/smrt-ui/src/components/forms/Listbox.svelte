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
  prepareEnabledOptionValue,
  validatesEnabledOption,
} from './control-value-validation.js';
import { useControlRegistration } from './use-control-registration.svelte.js';
export interface Props {
  /** Array of options to select from. */
  options: ControlOption[];
  /** Currently selected option value (bindable). */
  value?: string | number;
  /** Accessibility label for the listbox. */
  label: string;
  /** HTML form field name. */
  name?: string;
  /** Whether the listbox is disabled. */
  disabled?: boolean;
  /** Interaction options or false to disable all. */
  interaction?: ControlInteractionOptions | false;
  /** Callback when the selected value changes. */
  onvaluechange?: (value: string | number) => void;
  /** CSS class to apply to the listbox container. */
  class?: string;
}
let {
  options,
  value = $bindable(),
  label,
  name,
  disabled = false,
  interaction,
  onvaluechange,
  class: className = '',
}: Props = $props();
const instanceId = $props.id();
const interactionContext = tryGetControlInteractionContext();
let rootEl = $state<HTMLDivElement | null>(null);
let optionEls = $state<Array<HTMLButtonElement | null>>([]);
const controlId = $derived(
  interaction === false
    ? undefined
    : (interaction?.id ?? name ?? `listbox-${instanceId}`),
);
function select(next: unknown, userEdit = false) {
  const option = options.find((item) => String(item.value) === String(next));
  if (!option || option.disabled || disabled) return;
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
function move(event: KeyboardEvent, index: number) {
  let next = index;
  if (event.key === 'ArrowDown') next = (index + 1) % options.length;
  else if (event.key === 'ArrowUp')
    next = (index - 1 + options.length) % options.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = options.length - 1;
  else return;
  event.preventDefault();
  while (options[next]?.disabled && next !== index)
    next =
      event.key === 'ArrowUp'
        ? (next - 1 + options.length) % options.length
        : (next + 1) % options.length;
  optionEls[next]?.focus();
}
useControlRegistration(() => {
  const root = rootEl;
  if (!root || interaction === false) return false;
  return {
    controlId,
    subject: interaction?.subject,
    metadata: {
      kind: 'listbox',
      label,
      description: interaction?.description,
      sensitivity: interaction?.sensitivity ?? 'public',
      readable: interaction?.readable,
      writable: interaction?.writable,
      options,
    },
    getValue: () => value,
    prepareValue: (next) => prepareEnabledOptionValue(options, next),
    setValue: select,
    clear: () => {
      value = undefined;
      return true;
    },
    focus: () => optionEls.find((item) => item && !item.disabled)?.focus(),
    reveal: () => revealControl(root),
    highlight: (durationMs) => highlightControl(root, durationMs),
    validateValue: (next) => validatesEnabledOption(options, next),
    getState: () => ({
      disabled: disabled || root.closest('fieldset:disabled') !== null,
    }),
  };
});
</script>
<div bind:this={rootEl} class="listbox {className}" role="listbox" aria-label={label} aria-disabled={disabled} data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={interaction === false ? undefined : interaction?.subject?.type}
  data-smrt-subject-id={interaction === false ? undefined : interaction?.subject?.id}>
  {#each options as option, index (option.value)}<button bind:this={optionEls[index]} type="button" role="option" aria-selected={value === option.value}
    disabled={disabled || option.disabled} tabindex={value === option.value || (value === undefined && index === 0) ? 0 : -1}
    onkeydown={(event) => move(event, index)} onclick={() => select(option.value, true)}>{option.label}</button>{/each}
</div>
<style>
  .listbox { display: grid; padding: var(--smrt-spacing-1); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface); }
  button { padding: var(--smrt-spacing-2) var(--smrt-spacing-3); border: 0; border-radius: var(--smrt-radius-extra-small); background: transparent; color: var(--smrt-color-on-surface); text-align: left; cursor: pointer; }
  button[aria-selected='true'] { background: var(--smrt-color-secondary-container); color: var(--smrt-color-on-secondary-container); } button:focus-visible { outline: 2px solid var(--smrt-color-primary); }
  button:disabled { opacity: .5; cursor: not-allowed; } :global(.listbox[data-smrt-highlighted='true']) { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; }
</style>
