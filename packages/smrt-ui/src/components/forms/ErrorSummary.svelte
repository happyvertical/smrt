<script lang="ts">
import { focusControl } from './control-dom.js';
import type { FormError } from './types.js';
export interface Props {
  errors: FormError[];
  title?: string;
  onselect?: (controlId: string) => void;
  class?: string;
}
let {
  errors,
  title = 'Please correct the following',
  onselect,
  class: className = '',
}: Props = $props();
const instanceId = $props.id();
const titleId = `error-summary-${instanceId}`;
function select(error: FormError) {
  const target = document.querySelector<HTMLElement>(
    `[data-smrt-control="${CSS.escape(error.controlId)}"]`,
  );
  target?.scrollIntoView({ block: 'center' });
  if (target) focusControl(target);
  onselect?.(error.controlId);
}
</script>
{#if errors.length > 0}<section class="error-summary {className}" role="alert" aria-labelledby={titleId}><h2 id={titleId}>{title}</h2><ul>{#each errors as error}<li><button type="button" onclick={() => select(error)}>{error.label ? `${error.label}: ` : ''}{error.message}</button></li>{/each}</ul></section>{/if}
<style>
  .error-summary { padding: var(--smrt-spacing-4); border-inline-start: 4px solid var(--smrt-color-error); border-radius: var(--smrt-radius-small); background: var(--smrt-color-error-container); color: var(--smrt-color-on-error-container); }
  h2 { margin: 0 0 var(--smrt-spacing-2); font: var(--smrt-typography-title-small-font); } ul { margin: 0; padding-inline-start: var(--smrt-spacing-5); }
  button { padding: 0; border: 0; background: transparent; color: inherit; text-decoration: underline; cursor: pointer; }
</style>
