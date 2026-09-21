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
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.js';
import type { AssistantAttachmentRef } from './assistant-transport.js';

const { t } = useI18n();

export interface Props {
  /** Called with the trimmed message text and any staged attachments when
   * the user sends — via Enter or the Send button. May return a Promise
   * (or reject/throw): the draft text and staged attachments are kept until
   * it settles, cleared only on success (#2904 review finding 4) — a
   * rejection restores them and shows an inline error. */
  onsend: (
    content: string,
    attachments: AssistantAttachmentRef[],
  ) => void | Promise<void>;
  /** Called with the picked/dropped files; resolves to the uploaded
   * attachment refs to stage as removable chips above the input. */
  onupload: (files: FileList) => Promise<AssistantAttachmentRef[]>;
  /** Disables the composer (e.g. no active thread yet). */
  disabled?: boolean;
  /** Placeholder text for the empty textarea. */
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
let sending = $state(false);
let sendError = $state<string | null>(null);
// Cycle-2 third final: a rejecting onupload (e.g. the default
// createSmrtAssistantTransport's requireWrite('uploadAttachment') error when
// no writeEndpoint is configured) previously had no catch anywhere in
// handleFileChange/handleDrop — the chip row silently never updated and the
// rejection escaped as an unhandled promise rejection from the DOM event
// handler. Distinct slot from `sendError` since the two failures are
// unrelated and can occur independently (e.g. staging fails while a
// previous message is still sending).
let uploadError = $state<string | null>(null);
let fileInputEl: HTMLInputElement | undefined;
// Captured from the textarea's input event so auto-resize works without
// binding to the Textarea primitive's inner DOM node.
let textareaEl: HTMLTextAreaElement | undefined;

async function handleFileChange(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const files = input.files;
  if (!files || files.length === 0) return;
  uploading = true;
  uploadError = null;
  try {
    const uploaded = await onupload(files);
    stagedAttachments = [...stagedAttachments, ...uploaded];
  } catch (error) {
    // Already-staged chips are left untouched — only this batch failed.
    uploadError =
      error instanceof Error
        ? error.message
        : t(M['chat.assistant_composer.upload_failed']);
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
  uploadError = null;
  try {
    const uploaded = await onupload(files);
    stagedAttachments = [...stagedAttachments, ...uploaded];
  } catch (error) {
    // Already-staged chips are left untouched — only this batch failed.
    uploadError =
      error instanceof Error
        ? error.message
        : t(M['chat.assistant_composer.upload_failed']);
  } finally {
    uploading = false;
  }
}

async function handleSend() {
  const trimmed = content.trim();
  if (!trimmed || disabled || sending) return;
  sendError = null;
  sending = true;
  // #2904 review finding 4: keep the draft text/attachments until onsend
  // settles — clearing them synchronously (the previous behavior) lost the
  // user's message forever on a transport failure, with no visible error.
  try {
    await onsend(trimmed, stagedAttachments);
    content = '';
    stagedAttachments = [];
    if (textareaEl) {
      textareaEl.style.height = 'auto';
    }
  } catch (error) {
    sendError =
      error instanceof Error
        ? error.message
        : t(M['chat.assistant_composer.send_failed']);
  } finally {
    sending = false;
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
  {#if sendError}
    <p class="assistant-composer-error" role="alert">
      {t(M['chat.assistant_composer.send_error'], { message: sendError })}
    </p>
  {/if}
  {#if uploadError}
    <p class="assistant-composer-error" role="alert">
      {t(M['chat.assistant_composer.upload_error'], { message: uploadError })}
    </p>
  {/if}
  {#if stagedAttachments.length > 0}
    <ul class="assistant-composer-attachments">
      {#each stagedAttachments as attachment (attachment.id)}
        <li class="assistant-composer-chip">
          <span class="assistant-composer-chip-name">{attachment.name}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="assistant-composer-chip-remove"
            onclick={() => removeAttachment(attachment.id)}
            aria-label={t(M['chat.assistant_composer.remove_attachment'], {
              name: attachment.name,
            })}
          >
            ×
          </Button>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="assistant-composer-row">
    <!-- raw-primitive-allow: compact icon-only attach control backed by a hidden native file input; opens the OS picker, matching MessageInput's icon-button send control pattern -->
    <Button
      type="button"
      variant="secondary"
      size="sm"
      class="assistant-composer-attach"
      onclick={() => fileInputEl?.click()}
      disabled={disabled || uploading}
      aria-label={t(M['chat.assistant_composer.attach_files'])}
      title={t(M['chat.assistant_composer.attach_files'])}
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
    </Button>
    <!-- raw-primitive-allow: visually-hidden native file input that backs the attach button's OS picker; the base Input primitive renders a visible bordered control and cannot be this hidden picker (same pattern as ../shared/FileUpload.svelte). Cycle-3 second final F2: the visually-hidden clip-rect styling keeps this element IN the accessibility tree, so unlike FileUpload's own wrapping label element with visible text, this needs an explicit aria-label to avoid an unnamed file control. -->
    <input
      bind:this={fileInputEl}
      type="file"
      class="assistant-composer-file-input"
      multiple
      onchange={handleFileChange}
      disabled={disabled || uploading}
      tabindex="-1"
      aria-label={t(M['chat.assistant_composer.attach_files'])}
    />
    <Textarea
      bind:value={content}
      class="assistant-composer-textarea"
      {placeholder}
      disabled={disabled || uploading}
      rows={1}
      onkeydown={handleKeydown}
      oninput={handleInput}
      aria-label={t(M['chat.assistant_composer.message_label'])}
    />
    <Button
      type="button"
      class="assistant-composer-send"
      onclick={handleSend}
      disabled={disabled || uploading || sending || !content.trim()}
    >
      {t(M['chat.assistant_composer.send'])}
    </Button>
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

  :global(.assistant-composer-attach) {
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

  :global(.assistant-composer-attach:hover:not(:disabled)) {
    background: var(--smrt-color-surface-container, #f0f0f4);
  }

  :global(.assistant-composer-attach:disabled) {
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
    /* #3000: form controls don't inherit font; use the theme's family. */
    font-family: var(--smrt-font-family, inherit);
  }

  :global(.assistant-composer-send) {
    flex-shrink: 0;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border: none;
    border-radius: var(--smrt-radius-medium, 8px);
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    font: var(--smrt-typography-label-large-font, 500 0.875rem/1.25 sans-serif);
    cursor: pointer;
  }

  :global(.assistant-composer-send:disabled) {
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

  :global(.assistant-composer-chip-remove) {
    border: none;
    background: none;
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    line-height: 1;
    padding: 0;
  }

  .assistant-composer-error {
    margin: 0 0 var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-medium, 8px);
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-on-error-container, #410002);
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
  }
</style>
