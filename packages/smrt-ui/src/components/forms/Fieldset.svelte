<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLFieldsetAttributes } from 'svelte/elements';
export interface Props extends Omit<HTMLFieldsetAttributes, 'class'> {
  /** Legend text that labels the fieldset. */
  legend: string;
  /** Optional description text displayed below the legend. */
  description?: string;
  /** Optional error message displayed in alert color. */
  error?: string;
  /** Lays the fields out in one column with a gap between them. */
  stack?: boolean;
  /** CSS class to apply to the fieldset. */
  class?: string;
  /** Form controls and content inside the fieldset. */
  children: Snippet;
}
let {
  legend,
  description,
  error,
  stack = false,
  class: className = '',
  children,
  ...rest
}: Props = $props();
const instanceId = $props.id();
const descriptionId = $derived(
  description ? `fieldset-${instanceId}-description` : undefined,
);
const errorId = $derived(error ? `fieldset-${instanceId}-error` : undefined);
</script>
<fieldset class="smrt-fieldset__root {className}" aria-describedby={[descriptionId, errorId].filter(Boolean).join(' ') || undefined} {...rest} data-smrt-component="Fieldset">
  <legend>{legend}</legend>{#if description}<p id={descriptionId} class="smrt-fieldset__description" data-smrt-part="description">{description}</p>{/if}<div class="smrt-fieldset__body" class:smrt-fieldset__body--stack={stack} data-smrt-part="body">{@render children()}</div>{#if error}<p id={errorId} class="smrt-fieldset__error" data-smrt-part="error" role="alert">{error}</p>{/if}
</fieldset>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-fieldset__root {
    margin: 0;
    padding: var(--smrt-spacing-4);
  }
  legend {
    padding: 0 var(--smrt-spacing-2);
  }
  .smrt-fieldset__body--stack {
    display: grid;
    gap: var(--smrt-spacing-4);
  }
  .smrt-fieldset__description, .smrt-fieldset__error {
    margin: 0 0 var(--smrt-spacing-3);
  }
  .smrt-fieldset__error {
    margin: var(--smrt-spacing-3) 0 0;
  }
}

@layer smrt.theme {
  .smrt-fieldset__root {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium);
  }
  legend {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-small-font);
  }
  .smrt-fieldset__description, .smrt-fieldset__error {
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-fieldset__error {
    color: var(--smrt-color-error);
  }
}

</style>
