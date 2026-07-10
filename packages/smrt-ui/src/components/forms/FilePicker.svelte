<script lang="ts">
import type { HTMLInputAttributes } from 'svelte/elements';
import { highlightControl, revealControl } from './control-dom.js';
import type { ControlInteractionOptions } from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import { useControlRegistration } from './use-control-registration.svelte.js';
export interface Props
  extends Omit<HTMLInputAttributes, 'type' | 'class' | 'value' | 'files'> {
  files?: File[];
  label?: string;
  description?: string;
  dropzone?: boolean;
  class?: string;
  interaction?: ControlInteractionOptions | false;
  onchangefiles?: (files: File[]) => void;
}
let {
  files = $bindable([]),
  label = 'Choose files',
  description = 'Drop files here or browse',
  dropzone = false,
  id,
  name,
  accept,
  multiple = false,
  disabled = false,
  required = false,
  class: className = '',
  interaction,
  onchange,
  onchangefiles,
  ...rest
}: Props = $props();
const instanceId = $props.id();
const interactionContext = tryGetControlInteractionContext();
let inputEl = $state<HTMLInputElement | null>(null);
let rootEl = $state<HTMLLabelElement | null>(null);
const resolvedId = $derived(id ?? `smrt-file-${instanceId}`);
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name ?? resolvedId),
);
let dragging = $state(false);
function setFiles(next: FileList | File[], syncInput = true) {
  files = Array.from(next).slice(0, multiple ? undefined : 1);
  if (syncInput && inputEl && typeof DataTransfer !== 'undefined') {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    inputEl.files = transfer.files;
  }
  onchangefiles?.(files);
}
function handleChange(event: Event & { currentTarget: HTMLInputElement }) {
  setFiles(event.currentTarget.files ?? [], false);
  onchange?.(event);
}
function handleDrop(event: DragEvent) {
  event.preventDefault();
  dragging = false;
  if (!disabled && event.dataTransfer?.files)
    setFiles(event.dataTransfer.files);
}
export function open(): void {
  if (!disabled) inputEl?.click();
}
export function clear(): void {
  files = [];
  if (inputEl) inputEl.value = '';
  onchangefiles?.([]);
}
export function getElement(): HTMLInputElement | null {
  return inputEl;
}
useControlRegistration(() => {
  const input = inputEl;
  const root = rootEl;
  if (!input || !root || interaction === false) return false;
  return {
    controlId,
    subject: interaction?.subject,
    metadata: {
      kind: 'file',
      label,
      description: interaction?.description ?? description,
      sensitivity: interaction?.sensitivity ?? 'sensitive',
      readable: false,
      writable: false,
      constraints: { required: required === true },
      capabilities: ['focus', 'reveal', 'highlight', 'explain', 'validate'],
    },
    focus: () => input.focus(),
    reveal: () => revealControl(root),
    highlight: (durationMs) => highlightControl(root, durationMs),
    validate: () => input.reportValidity(),
    getState: () => ({
      disabled: input.disabled,
      valid: input.validity.valid,
      validationMessage: input.validationMessage || undefined,
    }),
  };
});
</script>
<label bind:this={rootEl} for={resolvedId} class="file-picker {className}" class:dropzone class:dragging class:disabled
  data-smrt-control={controlId} data-smrt-form={interactionContext?.formId} ondragenter={(event) => { event.preventDefault(); dragging = true; }}
  ondragover={(event) => event.preventDefault()} ondragleave={() => dragging = false} ondrop={handleDrop}>
  <input bind:this={inputEl} id={resolvedId} type="file" {name} {accept} {multiple} {disabled} {required} onchange={handleChange} {...rest} />
  <span class="label">{label}</span><span class="description">{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} selected` : description}</span>
</label>
<style>
  .file-picker { display: inline-flex; flex-direction: column; gap: var(--smrt-spacing-1); padding: var(--smrt-spacing-3) var(--smrt-spacing-4); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); cursor: pointer; }
  .file-picker.dropzone { width: 100%; min-height: 8rem; align-items: center; justify-content: center; border-style: dashed; text-align: center; }
  .file-picker.dragging { border-color: var(--smrt-color-primary); background: var(--smrt-color-primary-container); }
  .file-picker.disabled { opacity: .5; cursor: not-allowed; } input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  input:focus-visible ~ .label { outline: 2px solid var(--smrt-color-primary); outline-offset: 3px; }
  .label { font: var(--smrt-typography-label-large-font); } .description { font: var(--smrt-typography-body-small-font); color: var(--smrt-color-on-surface-variant); }
  .file-picker[data-smrt-highlighted='true'] { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; }
</style>
