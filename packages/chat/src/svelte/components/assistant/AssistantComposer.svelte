<script lang="ts">
/**
 * AssistantComposer - text + attachment composer for AssistantDock (#2904).
 *
 * Enter-to-send / Shift+Enter-for-newline matches the package convention in
 * `../messages/MessageInput.svelte` (same `Textarea` primitive, same
 * `handleKeydown` shape). Attachments use a compact attach button + a small
 * chip row instead of the full `../shared/FileUpload.svelte` dropzone/preview
 * flow, which is sized for a dedicated upload panel, not a one-line composer
 * (#2904 review fix).
 */
import { Textarea } from '@happyvertical/smrt-ui/forms';
import type { AssistantAttachmentRef } from './assistant-transport.js';

export interface Props {
  onsend: (content: string, attachments: AssistantAttachmentRef[]) => void;
  onupload: (files: FileList) => Promise<AssistantAttachmentRef[]>;
  disabled?: boolean;
  placeholder?: string;
}

const {
  onsend,
  onupload,
  disabled = false,
  placeholder = 'Ask the assistant…',
}: Props = $props();

let content = $state('');
let stagedAttachments = $state<AssistantAttachmentRef[]>([]);
let uploading = $state(false);
let fileInputEl: HTMLInputElement | undefined;
// Captured from the textarea's input event so auto-resize works without
// binding to the Textarea primitive's inner DOM node.
let textareaEl: HTMLTextAreaElement | undefined;

async function handleFileChange(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const files = input.files;
  if (!files || files.length === 0) return;
  uploading = true;
  try {
    const uploaded = await onupload(files);
    stagedAttachments = [...stagedAttachments, ...uploaded];
  } finally {
    uploading = false;
    input.value = '';
  }
}

async function handleDrop(event: DragEvent) {
  event.preventDefault();
  if (disabled || uploading) return;
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  uploading = true;
  try {
    const uploaded = await onupload(files);
    stagedAttachments = [...stagedAttachments, ...uploaded];
  } finally {
    uploading = false;
  }
}

function handleSend() {
  const trimmed = content.trim();
  if (!trimmed || disabled) return;
  onsend(trimmed, stagedAttachments);
  content = '';
  stagedAttachments = [];
  if (textareaEl) {
    textareaEl.style.height = 'auto';
  }
}

function handleKeydown(event: KeyboardEvent) {
  // Matches ../messages/MessageInput.svelte's handleKeydown convention:
  // plain Enter sends, Shift+Enter inserts a newline. `isComposing` guards
  // against an IME's confirmation Enter being treated as a send.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    handleSend();
  }
}

function handleInput(event: Event) {
  const el = event.currentTarget as HTMLTextAreaElement;
  textareaEl = el;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

function removeAttachment(id: string) {
  stagedAttachments = stagedAttachments.filter((a) => a.id !== id);
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="assistant-composer" ondrop={handleDrop} ondragover={(e) => e.preventDefault()}>
  {#if stagedAttachments.length > 0}
    <ul class="assistant-composer-attachments">
      {#each stagedAttachments as attachment (attachment.id)}
        <li class="assistant-composer-chip">
          <span class="assistant-composer-chip-name">{attachment.name}</span>
          <button
            type="button"
            class="assistant-composer-chip-remove"
            onclick={() => removeAttachment(attachment.id)}
            aria-label={`Remove ${attachment.name}`}
          >
            ×
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="assistant-composer-row">
    <!-- raw-primitive-allow: compact icon-only attach control backed by a hidden native file input; opens the OS picker, matching MessageInput's icon-button send control pattern -->
    <button
      type="button"
      class="assistant-composer-attach"
      onclick={() => fileInputEl?.click()}
      disabled={disabled || uploading}
      aria-label="Attach files"
      title="Attach files"
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <path
          d="M14.5 6.5l-6 6a2.5 2.5 0 003.54 3.54l6-6a4.5 4.5 0 00-6.36-6.36l-6.5 6.5a6.5 6.5 0 009.19 9.19"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <input
      bind:this={fileInputEl}
      type="file"
      class="assistant-composer-file-input"
      multiple
      onchange={handleFileChange}
      disabled={disabled || uploading}
      tabindex="-1"
    />
    <Textarea
      bind:value={content}
      class="assistant-composer-textarea"
      {placeholder}
      disabled={disabled || uploading}
      rows={1}
      onkeydown={handleKeydown}
      oninput={handleInput}
      aria-label="Message"
    />
    <button
      type="button"
      class="assistant-composer-send"
      onclick={handleSend}
      disabled={disabled || uploading || !content.trim()}
    >
      Send
    </button>
  </div>
</div>

<style>
  .assistant-composer {
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    background: var(--smrt-color-surface, #ffffff);
    padding: var(--smrt-spacing-2, 8px);
    flex-shrink: 0;
  }

  .assistant-composer-row {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 8px);
  }

  .assistant-composer-attach {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
  }

  .assistant-composer-attach:hover:not(:disabled) {
    background: var(--smrt-color-surface-container, #f0f0f4);
  }

  .assistant-composer-attach:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .assistant-composer-file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  :global(.assistant-composer-textarea) {
    flex: 1;
    resize: none;
  }

  .assistant-composer-send {
    flex-shrink: 0;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border: none;
    border-radius: var(--smrt-radius-medium, 8px);
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    font: var(--smrt-typography-label-large-font, 500 0.875rem/1.25 sans-serif);
    cursor: pointer;
  }

  .assistant-composer-send:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .assistant-composer-attachments {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2, 8px);
    margin: 0 0 var(--smrt-spacing-2, 8px);
    padding: 0;
  }

  .assistant-composer-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    max-width: 160px;
  }

  .assistant-composer-chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .assistant-composer-chip-remove {
    border: none;
    background: none;
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    line-height: 1;
    padding: 0;
  }
</style>
