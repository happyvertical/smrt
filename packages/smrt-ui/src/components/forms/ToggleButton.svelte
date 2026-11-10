<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';
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
import { prepareBooleanControlValue } from './control-value-validation.js';
import { useControlRegistration } from './use-control-registration.svelte.js';

export interface Props extends Omit<HTMLButtonAttributes, 'class'> {
  /** Whether the button is in pressed state. */
  pressed?: boolean;
  /** Additional CSS class names. */
  class?: string;
  /** Registers this control for agent interaction; omit or pass false to exclude. */
  interaction?: ControlInteractionOptions | false;
  /** The button content. */
  children?: Snippet;
}
let {
  pressed = $bindable(false),
  id,
  name,
  disabled = false,
  class: className = '',
  interaction,
  children,
  onclick,
  'aria-label': ariaLabel,
  ...rest
}: Props = $props();
const instanceId = $props.id();
const interactionContext = tryGetControlInteractionContext();
let buttonEl = $state<HTMLButtonElement | null>(null);
const resolvedId = $derived(id ?? `smrt-toggle-button-${instanceId}`);
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name ?? resolvedId),
);
function setPressed(next: unknown) {
  pressed = Boolean(next);
  if (buttonEl) emitControlChange(buttonEl);
}
function handleClick(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
  pressed = !pressed;
  recordControlUserEdit(
    interactionContext,
    controlId,
    interaction === false ? undefined : interaction?.subject,
  );
  if (buttonEl) emitControlChange(buttonEl);
  onclick?.(event);
}
useControlRegistration(() => {
  const element = buttonEl;
  if (!element || interaction === false) return false;
  return {
    controlId,
    subject: interaction?.subject,
    metadata: {
      kind: 'toggle-button',
      label: ariaLabel ?? (element.textContent?.trim() || undefined),
      description: interaction?.description,
      sensitivity: interaction?.sensitivity ?? 'public',
      readable: interaction?.readable,
      writable: interaction?.writable,
    },
    getValue: () => pressed,
    prepareValue: prepareBooleanControlValue,
    setValue: setPressed,
    clear: () => {
      setPressed(false);
      return true;
    },
    focus: () => element.focus(),
    reveal: () => revealControl(element),
    highlight: (durationMs) => highlightControl(element, durationMs),
    validateValue: (next) => typeof next === 'boolean',
    getState: () => ({ disabled: element.matches(':disabled') }),
  };
});
</script>
<button bind:this={buttonEl} id={resolvedId} type="button" {name} {disabled} class="smrt-toggle-button__root {className}" class:smrt-toggle-button__pressed={pressed}
  aria-pressed={pressed} aria-label={ariaLabel} data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={interaction === false ? undefined : interaction?.subject?.type}
  data-smrt-subject-id={interaction === false ? undefined : interaction?.subject?.id}
  onclick={handleClick} {...rest} data-smrt-component="ToggleButton">{@render children?.()}</button>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-toggle-button__root {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.5rem;
    padding: 0 var(--smrt-spacing-4);
    cursor: pointer;
  }
  .smrt-toggle-button__root:disabled {
    cursor: not-allowed;
  }
}

@layer smrt.theme {
  .smrt-toggle-button__root {
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .smrt-toggle-button__root.smrt-toggle-button__pressed {
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
    border-color: var(--smrt-color-secondary);
  }
  .smrt-toggle-button__root:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .smrt-toggle-button__root:disabled {
    opacity: .5;
  }
  .smrt-toggle-button__root[data-smrt-highlighted='true'] {
    outline: 3px solid var(--smrt-color-tertiary);
    outline-offset: 4px;
  }
  /* Forced colors (#3908): system colours where colour alone carries meaning. */
  @media (forced-colors: active) {
    .smrt-toggle-button__root.smrt-toggle-button__pressed {
      background: Highlight;
      color: HighlightText;
      border-color: Highlight;
    }
    .smrt-toggle-button__root:disabled, .smrt-toggle-button__root.smrt-toggle-button__pressed:disabled {
      opacity: 1;
      background: Canvas;
      color: GrayText;
      border-color: GrayText;
    }
  }
}

</style>
