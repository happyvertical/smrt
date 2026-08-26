<script lang="ts">
import { highlightControl, revealControl } from './control-dom.js';
import type { ControlInteractionOptions } from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import { useControlRegistration } from './use-control-registration.svelte.js';
export interface Props {
  values?: string[];
  label: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  maxTags?: number;
  allowDuplicates?: boolean;
  interaction?: ControlInteractionOptions | false;
  onvalueschange?: (values: string[]) => void;
  class?: string;
}
let {
  values = $bindable([]),
  label,
  name,
  placeholder = 'Add a tag',
  disabled = false,
  maxTags,
  allowDuplicates = false,
  interaction,
  onvalueschange,
  class: className = '',
}: Props = $props();
const instanceId = $props.id();
const inputId = `smrt-tags-${instanceId}`;
const interactionContext = tryGetControlInteractionContext();
let rootEl = $state<HTMLDivElement | null>(null);
let inputEl = $state<HTMLInputElement | null>(null);
let draft = $state('');
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name ?? inputId),
);
function commit(raw: string) {
  const tag = raw.trim();
  if (
    !tag ||
    disabled ||
    (maxTags !== undefined && values.length >= maxTags) ||
    (!allowDuplicates && values.includes(tag))
  )
    return;
  values = [...values, tag];
  draft = '';
  onvalueschange?.(values);
}
function remove(index: number) {
  values = values.filter((_, candidate) => candidate !== index);
  onvalueschange?.(values);
}
function setValues(next: unknown) {
  if (!Array.isArray(next)) return;
  values = next
    .map(String)
    .filter((tag, index, all) => allowDuplicates || all.indexOf(tag) === index)
    .slice(0, maxTags);
  onvalueschange?.(values);
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    commit(draft);
  } else if (event.key === 'Backspace' && !draft && values.length)
    remove(values.length - 1);
}
useControlRegistration(() => {
  const root = rootEl;
  const input = inputEl;
  if (!root || !input || interaction === false) return false;
  return {
    controlId,
    subject: interaction?.subject,
    metadata: {
      kind: 'tags-input',
      label,
      description: interaction?.description,
      sensitivity: interaction?.sensitivity ?? 'public',
      readable: interaction?.readable,
      writable: interaction?.writable,
    },
    getValue: () => [...values],
    setValue: setValues,
    clear: () => (setValues([]), true),
    focus: () => input.focus(),
    reveal: () => revealControl(root),
    highlight: (durationMs) => highlightControl(root, durationMs),
    getState: () => ({ disabled }),
  };
});
</script>
<div class="tags-field {className}"><label for={inputId}>{label}</label><div bind:this={rootEl} class="tags" data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={interaction === false ? undefined : interaction?.subject?.type}
  data-smrt-subject-id={interaction === false ? undefined : interaction?.subject?.id}>
  {#each values as tag, index}<span class="tag">{tag}<button type="button" disabled={disabled} aria-label={`Remove ${tag}`} onclick={() => remove(index)}>×</button><input type="hidden" name={name ? `${name}[]` : undefined} value={tag} /></span>{/each}
  <input bind:this={inputEl} id={inputId} {placeholder} {disabled} bind:value={draft} onkeydown={handleKeydown} onblur={() => commit(draft)} />
</div></div>
<style>
  .tags-field { display: grid; gap: var(--smrt-spacing-1); color: var(--smrt-color-on-surface); } label { font: var(--smrt-typography-label-large-font); }
  .tags { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-1); min-height: 2.5rem; padding: var(--smrt-spacing-1); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface); }
  .tag { display: inline-flex; align-items: center; gap: var(--smrt-spacing-1); padding: var(--smrt-spacing-1) var(--smrt-spacing-2); border-radius: var(--smrt-radius-full); background: var(--smrt-color-secondary-container); color: var(--smrt-color-on-secondary-container); }
  .tag button { border: 0; background: transparent; color: inherit; cursor: pointer; } .tags > input { flex: 1; min-width: 8rem; border: 0; outline: 0; background: transparent; color: inherit; }
  :global(.tags[data-smrt-highlighted='true']) { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; }
</style>
