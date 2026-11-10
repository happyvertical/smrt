<script lang="ts">
/**
 * FileUpload - Drag-and-drop file upload component
 *
 * Features:
 * - Drag-and-drop zone with visual feedback
 * - File list with remove buttons
 * - Accept filter (mime types / extensions)
 * - Multiple file support
 * - Max size validation
 * - Native form posting via `name` (the accepted list is mirrored onto the
 *   real input with `DataTransfer`, so picks, drops and removals post exactly
 *   what the list shows), `required` validation, and camera `capture`
 * - A reset of the owning form (`form.reset()`, a reset button, SvelteKit
 *   `enhance`'s `update()` after a success) empties the list, as it empties a
 *   native file input, and reports it through `onchange([])`
 * - Material 3 styling
 *
 * Fallback: where the `DataTransfer` constructor is unavailable (Safari < 14.1,
 * jsdom), the input keeps the browser's own selection only while it matches the
 * accepted list exactly; otherwise it is cleared. A native submit then never
 * posts a file the list does not show, but drops, accumulated picks and
 * partial removals post nothing until the next matching pick.
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n/strings.forms.js';

const { t } = useI18n();

export interface Props {
  /** Accepted file types (e.g., '.pdf,.csv' or 'application/pdf,text/csv') */
  accept?: string;
  /** Allow multiple files */
  multiple?: boolean;
  /** Selected files (bindable) */
  files?: File[];
  /** Callback when files change, including the empty list after a form reset */
  onchange?: (files: File[]) => void;
  /** Maximum file size in bytes */
  maxSize?: number;
  /** Disabled state */
  disabled?: boolean;
  /** Label text for the drop zone */
  label?: string;
  /** Hint text shown below the label */
  hint?: string;
  /** Form field name; the accepted files post under it in a native `multipart/form-data` submit */
  name?: string;
  /** Camera hint forwarded to the input: `environment` (rear) or `user` (front) */
  capture?: 'environment' | 'user';
  /** Require at least one file for native form validation */
  required?: boolean;
  /** Target density; omit to inherit the ThemeProvider setting. */
  density?: 'comfortable' | 'touch';
}

let {
  accept,
  multiple = false,
  files = $bindable([]),
  onchange,
  maxSize,
  disabled = false,
  label = 'Drag and drop files here',
  hint = 'or click to browse',
  name,
  capture,
  required = false,
  density,
}: Props = $props();

let isDragging = $state(false);
let error = $state<string | null>(null);
let inputRef = $state<HTMLInputElement | null>(null);

// Mirror the accepted list onto the real input so a native form submit posts
// exactly what the list shows (picks, drops, removals, and external resets of
// the bound `files`). Assigning `input.files` fires no change event.
$effect(() => {
  const input = inputRef;
  const current = files;
  if (!input) return;
  if (typeof DataTransfer === 'function') {
    try {
      const transfer = new DataTransfer();
      for (const file of current) transfer.items.add(file);
      input.files = transfer.files;
      return;
    } catch {
      // Constructor present but unusable; fall through to the fallback.
    }
  }
  const native = input.files ? Array.from(input.files) : [];
  const matches =
    native.length === current.length &&
    native.every((file, i) => file === current[i]);
  if (!matches) input.value = '';
});

// The owning form reset: the browser empties the native input, so the list
// must empty too or it keeps showing files that no longer post. `reset` fires
// before the browser resets the controls; clearing `files` makes the mirror
// effect above assign an empty list, so the two agree instead of fighting
// (and a cancelled reset still leaves list and input both empty). The capture
// phase on `document` reads the input's form at dispatch time, so moving the
// input between forms needs no re-wiring and no page listener can hide it.
$effect(() => {
  if (typeof document === 'undefined') return;
  const onReset = (event: Event) => {
    const form = inputRef?.form;
    if (!form || event.target !== form) return;
    const hadFiles = files.length > 0;
    error = null;
    isDragging = false;
    files = [];
    if (hadFiles) onchange?.(files);
  };
  document.addEventListener('reset', onReset, true);
  return () => document.removeEventListener('reset', onReset, true);
});

function handleDragEnter(e: DragEvent) {
  e.preventDefault();
  if (!disabled) isDragging = true;
}

function handleDragLeave(e: DragEvent) {
  e.preventDefault();
  isDragging = false;
}

function handleDragOver(e: DragEvent) {
  e.preventDefault();
}

function handleDrop(e: DragEvent) {
  e.preventDefault();
  isDragging = false;
  if (disabled) return;

  const droppedFiles = e.dataTransfer?.files;
  if (droppedFiles) {
    addFiles(Array.from(droppedFiles));
  }
}

function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files) {
    addFiles(Array.from(input.files));
  }
}

function handleInvalid(e: Event) {
  const input = e.currentTarget as HTMLInputElement;
  // The input is visually hidden and aria-hidden, so announce the native
  // validation failure through the live error region as well.
  error = input.validationMessage || t(M['ui.file_upload.required']);
}

function handleZoneClick() {
  if (!disabled) inputRef?.click();
}

function handleKeyDown(e: KeyboardEvent) {
  if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
    e.preventDefault();
    inputRef?.click();
  }
}

function isFileAccepted(file: File): boolean {
  if (!accept?.trim()) return true;

  const acceptList = accept
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (acceptList.length === 0) return true;

  const fileName = file.name.toLowerCase();
  const fileType = (file.type || '').toLowerCase();
  const fileExtIndex = fileName.lastIndexOf('.');
  const fileExt = fileExtIndex !== -1 ? fileName.slice(fileExtIndex) : '';

  return acceptList.some((rule) => {
    const r = rule.toLowerCase();
    if (r.startsWith('.')) return fileExt === r;
    if (r.endsWith('/*'))
      return fileType.startsWith(`${r.slice(0, r.indexOf('/'))}/`);
    return fileType === r;
  });
}

function addFiles(newFiles: File[]) {
  error = null;

  let filtered = newFiles;
  const errorMessages: string[] = [];

  // Validate accepted types
  const rejected = filtered.filter((f) => !isFileAccepted(f));
  if (rejected.length > 0) {
    errorMessages.push(
      t(M['ui.file_upload.rejected_type'], { count: rejected.length }),
    );
    filtered = filtered.filter((f) => isFileAccepted(f));
  }

  // Validate max size
  const limit = maxSize;
  if (limit) {
    const oversized = filtered.filter((f) => f.size > limit);
    if (oversized.length > 0) {
      errorMessages.push(
        t(M['ui.file_upload.exceeds_max_size'], {
          count: oversized.length,
          size: formatFileSize(limit),
        }),
      );
      filtered = filtered.filter((f) => f.size <= limit);
    }
  }

  if (errorMessages.length > 0) {
    error = errorMessages.join('. ');
  }

  if (!multiple) {
    files = filtered.slice(0, 1);
  } else {
    // Avoid duplicates by name
    const existingNames = new Set(files.map((f) => f.name));
    const unique = filtered.filter((f) => !existingNames.has(f.name));
    files = [...files, ...unique];
  }

  onchange?.(files);
}

function removeFile(index: number) {
  files = files.filter((_, i) => i !== index);
  onchange?.(files);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<div class="smrt-file-upload__root" class:smrt-file-upload__disabled={disabled} data-density={density} data-smrt-component="FileUpload">
  <div
    class="smrt-file-upload__drop-zone"
    class:smrt-file-upload__dragging={isDragging}
    data-smrt-part="trigger"
    role="button"
    tabindex={disabled ? -1 : 0}
    ondragenter={handleDragEnter}
    ondragleave={handleDragLeave}
    ondragover={handleDragOver}
    ondrop={handleDrop}
    onclick={handleZoneClick}
    onkeydown={handleKeyDown}
  >
    <div class="smrt-file-upload__drop-zone-icon" data-smrt-part="icon">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    </div>
    <p class="smrt-file-upload__drop-zone-label" data-smrt-part="label">{label}</p>
    <p class="smrt-file-upload__drop-zone-hint" data-smrt-part="description">{hint}</p>
  </div>
  <!-- Visually hidden rather than `hidden`: a hidden control cannot be focused,
       so the browser could not show its `required` validation bubble and would
       silently block the submit. The drop zone stays the one control exposed
       to assistive tech and the tab order. -->
  <input
    bind:this={inputRef}
    class="smrt-file-upload__input"
    data-smrt-part="input"
    type="file"
    {name}
    {accept}
    {multiple}
    {capture}
    {required}
    {disabled}
    tabindex="-1"
    aria-hidden="true"
    onchange={handleFileSelect}
    oninvalid={handleInvalid}
  />

  {#if error}
    <!-- Live region so async validation/reject errors are announced (C7),
         matching the Form/TextInput announcing pattern. -->
    <p class="smrt-file-upload__error" data-smrt-part="error" role="alert" aria-live="assertive">{error}</p>
  {/if}

  {#if files.length > 0}
    <ul class="smrt-file-upload__file-list" data-smrt-part="list">
      {#each files as file, i (file.name)}
        <li class="smrt-file-upload__file-item" data-smrt-part="row">
          <span class="smrt-file-upload__file-name" data-smrt-part="title">{file.name}</span>
          <span class="smrt-file-upload__file-size" data-smrt-part="meta">{formatFileSize(file.size)}</span>
          <button
            class="smrt-file-upload__file-remove"
            data-smrt-part="close"
            onclick={() => removeFile(i)}
            aria-label={t(M['ui.file_upload.remove_file'], { name: file.name })}
            type="button"
            {disabled}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-file-upload__root {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-file-upload__input {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    width: 1px;
    height: 1px;
    margin: 0;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .smrt-file-upload__drop-zone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-8, 2rem) var(--smrt-spacing-6, 1.5rem);
    cursor: pointer;
  }
  .smrt-file-upload__drop-zone-label {
    margin: 0;
  }
  .smrt-file-upload__drop-zone-hint {
    margin: 0;
  }
  .smrt-file-upload__error {
    margin: 0;
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-file-upload__file-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow: hidden;
  }
  .smrt-file-upload__file-item {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-file-upload__file-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-file-upload__file-size {
    white-space: nowrap;
  }
  .smrt-file-upload__file-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: max(28px, var(--smrt-control-target-min));
    height: max(28px, var(--smrt-control-target-min));
    padding: 0;
    cursor: pointer;
  }
  .smrt-file-upload__root.smrt-file-upload__disabled {
    pointer-events: none;
  }
  .smrt-file-upload__root[data-density='touch'] {
    --smrt-control-target-min: var(--smrt-touch-target-min);
  }
  .smrt-file-upload__root[data-density='comfortable'] {
    --smrt-control-target-min: 0px;
  }
}

@layer smrt.theme {
  .smrt-file-upload__input {
    border: 0;
  }
  .smrt-file-upload__root.smrt-file-upload__disabled {
    opacity: 0.5;
  }
  .smrt-file-upload__drop-zone {
    border: 2px dashed var(--smrt-color-outline);
    border-radius: var(--smrt-radius-lg, 1rem);
    background: var(--smrt-color-surface-container-low);
    transition: all 200ms;
    text-align: center;
  }
  .smrt-file-upload__drop-zone:hover {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-surface-container);
  }
  .smrt-file-upload__drop-zone:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }
  .smrt-file-upload__drop-zone.smrt-file-upload__dragging {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
    border-style: solid;
  }
  .smrt-file-upload__drop-zone-icon {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-file-upload__drop-zone-label {
    font: var(--smrt-typography-body-large-font);
    color: var(--smrt-color-on-surface);
  }
  .smrt-file-upload__drop-zone-hint {
    font: var(--smrt-typography-body-small-font);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-file-upload__error {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
    border-radius: var(--smrt-radius-sm, 0.25rem);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-file-upload__file-list {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md, 0.5rem);
  }
  .smrt-file-upload__file-item {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-file-upload__file-item:last-child {
    border-bottom: none;
  }
  .smrt-file-upload__file-name {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface);
  }
  .smrt-file-upload__file-size {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-file-upload__file-remove {
    border: none;
    border-radius: var(--smrt-radius-full);
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    transition: background-color 200ms;
  }
  .smrt-file-upload__file-remove:hover {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-error);
  }
}

</style>
