<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLFieldsetAttributes } from 'svelte/elements';
export interface Props extends Omit<HTMLFieldsetAttributes, 'class'> {
  legend: string;
  description?: string;
  error?: string;
  class?: string;
  children: Snippet;
}
let {
  legend,
  description,
  error,
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
<fieldset class="fieldset {className}" aria-describedby={[descriptionId, errorId].filter(Boolean).join(' ') || undefined} {...rest}>
  <legend>{legend}</legend>{#if description}<p id={descriptionId} class="description">{description}</p>{/if}<div class="content">{@render children()}</div>{#if error}<p id={errorId} class="error" role="alert">{error}</p>{/if}
</fieldset>
<style>
  .fieldset { margin: 0; padding: var(--smrt-spacing-4); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium); }
  legend { padding: 0 var(--smrt-spacing-2); color: var(--smrt-color-on-surface); font: var(--smrt-typography-title-small-font); }
  .description, .error { margin: 0 0 var(--smrt-spacing-3); font: var(--smrt-typography-body-small-font); color: var(--smrt-color-on-surface-variant); } .error { margin: var(--smrt-spacing-3) 0 0; color: var(--smrt-color-error); }
</style>
