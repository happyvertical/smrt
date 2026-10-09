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
import {
  Dictation,
  DictationButton,
  type DictationSourceProvider,
  DictationStatus,
  type DictationTranscribe,
  type HandsFreeCaptureFactory,
  type HandsFreeVadOptions,
  insertTextAtCursor,
  longPress,
  primeReadyBeep,
  Textarea,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy, untrack } from 'svelte';
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
  onupload?: (files: FileList) => Promise<AssistantAttachmentRef[]>;
  /** Disables the composer (e.g. no active thread yet). */
  disabled?: boolean;
  /** Placeholder text for the empty textarea. */
  placeholder?: string;
  /** The draft text (#2991). Bindable: a host can seed it with a prompt for
   * the user to edit, and read back what they typed. Setting it never sends.
   * Cleared after `onsend` resolves. */
  value?: string;
  /**
   * Speak instead of typing: a speech source (smrt-svelte's
   * `createSttDictationSource()`). With one, the composer shows a
   * microphone button, and pressing and holding the message box starts
   * listening too (it keeps listening after the finger comes up; tap the
   * microphone, send, or press Escape to stop). Heard words go in at the
   * cursor. Without one there is no microphone.
   */
  dictation?: DictationSourceProvider | null;
  /**
   * Writes a recorded message down, for browsers whose speech recognition
   * is missing or broken (Firefox, Brave): the composer then records the
   * message and shows "Writing it down…" while this runs. Normally smrt-ui's
   * `createHttpTranscriber('/your/route')`. Also shows the microphone on its
   * own, without `dictation`.
   */
  transcribe?: DictationTranscribe | null;
  /**
   * `'hands-free'`: the microphone stays on and each sentence is written
   * down when the speaker pauses, with no tap per phrase; tapping the
   * microphone (or sending, or Escape) ends it. Needs `handsFreeCapture` and
   * an on-device speech source (smrt-svelte's `whisper-local` / `moonshine`);
   * otherwise it is ordinary press-to-talk. Default `'push'`.
   */
  dictationMode?: 'push' | 'hands-free';
  /**
   * The hands-free microphone, `createHandsFreeCapture` from
   * `@happyvertical/smrt-ui/forms/hands-free`.
   */
  handsFreeCapture?: HandsFreeCaptureFactory | null;
  /** Pause length and sensitivity for hands-free (see `HandsFreeVadOptions`). */
  handsFreeVad?: HandsFreeVadOptions;
  /**
   * Hands-free only: send the message once the speaker has been quiet for
   * `sendOnPauseMs` after the last sentence was written down (the same path
   * as pressing Send). A new sentence, a key press, Escape or the microphone
   * button cancels the pending send. Never sends an empty message. While a
   * send is in flight, or the composer is disabled, the send waits and the
   * text stays in the box until the composer can accept it again. Default
   * `false`.
   */
  sendOnPause?: boolean;
  /** Quiet time before `sendOnPause` sends, in ms. Default 1200. */
  sendOnPauseMs?: number;
  /**
   * The assistant's reply is being played aloud (text to speech). While
   * `true`, hands-free listening is suspended (half-duplex: the microphone
   * stays open but nothing is heard, so the assistant is not transcribed into
   * the box) and resumes after a short guard when it turns `false`. The
   * microphone shows "Paused while the assistant speaks". A pending send on
   * pause is unaffected; tapping the microphone still ends hands-free.
   * Default `false`.
   */
  speaking?: boolean;
}

let {
  onsend,
  onupload,
  disabled = false,
  placeholder = 'Ask the assistant…',
  value: content = $bindable(''),
  dictation: dictationSource = null,
  transcribe = null,
  dictationMode = 'push',
  handsFreeCapture = null,
  handsFreeVad,
  sendOnPause = false,
  sendOnPauseMs = 1200,
  speaking = false,
}: Props = $props();
const canDictate = $derived(Boolean(dictationSource || transcribe));
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
let fileInputEl: HTMLInputElement | undefined = $state();
// Captured from the textarea's input event so auto-resize works without
// binding to the Textarea primitive's inner DOM node.
let textareaEl: HTMLTextAreaElement | undefined;
// The Textarea primitive's own instance, for its public `getElement()`.
let textareaComponent:
  | { getElement(): HTMLTextAreaElement | null }
  | undefined = $state();

function messageField(): HTMLTextAreaElement | null {
  textareaEl ??= textareaComponent?.getElement() ?? undefined;
  return textareaEl ?? null;
}

/** Moves focus to the message field (a host that opens the composer
 * directly, e.g. AssistantDock `conversations="single"`). A no-op while the
 * composer is disabled. */
export function focus(): void {
  messageField()?.focus();
}

// Send on pause: true once a hands-free sentence has been written into the
// box and not yet sent, `autoSendCountdown` while the grace period runs, and
// `autoSendWaiting` when the grace period is over but a send is in flight.
let sendDictated = $state(false);
let autoSendCountdown = $state(false);
let autoSendWaiting = $state(false);

function cancelAutoSend() {
  sendDictated = false;
  autoSendCountdown = false;
  autoSendWaiting = false;
}

// One dictation per composer; the source is read when listening starts.
const dictation = new Dictation({
  source: () => {
    if (!dictationSource) throw new Error('Speech input is not available.');
    return dictationSource();
  },
  onText: (text) => {
    // A new sentence (re)arms the send-on-pause countdown.
    sendDictated = true;
    const field = messageField();
    if (field) insertTextAtCursor(field, text);
    else content = content ? `${content} ${text}` : text;
  },
});
// The recording fallback follows the prop (a host may set it later).
$effect.pre(() => {
  dictation.setOptions({
    transcribe,
    mode: dictationMode,
    handsFreeCapture,
    vad: handsFreeVad,
  });
});

onDestroy(() => dictation.dispose());

// Half-duplex: do not listen while the assistant's reply is played aloud.
$effect(() => {
  const on = speaking;
  untrack(() => (on ? dictation.suspend() : dictation.resume()));
});

// The grace period: quiet, nothing being written down, something to send.
// Speech starting (or a sentence still queued) clears it; the next written
// sentence starts it again.
$effect(() => {
  const armed =
    sendOnPause &&
    sendDictated &&
    dictation.handsFree &&
    dictation.state === 'listening' &&
    !dictation.speaking &&
    dictation.queued === 0 &&
    content.trim().length > 0;
  if (!armed) {
    autoSendCountdown = false;
    return;
  }
  autoSendCountdown = true;
  const timer = setTimeout(
    () => {
      autoSendCountdown = false;
      sendDictated = false;
      autoSendWaiting = true;
    },
    Math.max(0, sendOnPauseMs),
  );
  return () => clearTimeout(timer);
});

// Ends of the wait: send as soon as the composer can take input, but only
// while still hands-free (stopping the microphone cancels a pending send).
$effect(() => {
  if (!autoSendWaiting) return;
  if (!sendOnPause || !dictation.handsFree || !content.trim()) {
    autoSendWaiting = false;
    return;
  }
  if (dictation.speaking || dictation.queued > 0) {
    // More was said while waiting: back to the grace period.
    autoSendWaiting = false;
    sendDictated = true;
    return;
  }
  if (sending || disabled || uploading) return;
  autoSendWaiting = false;
  void handleSend(true);
});

// Hands-free ended (microphone tapped, Escape, an error): nothing is sent.
$effect(() => {
  if (!dictation.handsFree) cancelAutoSend();
});

function startDictationFromHold() {
  if (disabled || uploading || dictation.active) return;
  void dictation.start();
}

function resize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

// #2991: a seeded draft never fires the textarea's input event, so size the
// textarea to it here. Typed input still resizes through handleInput.
$effect(() => {
  void content;
  textareaEl ??= textareaComponent?.getElement() ?? undefined;
  if (textareaEl) resize(textareaEl);
});

async function handleFileChange(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const files = input.files;
  if (!files || files.length === 0) return;
  uploading = true;
  uploadError = null;
  const upload = onupload;
  if (!upload) {
    uploading = false;
    input.value = '';
    return;
  }
  try {
    const uploaded = await upload(files);
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
  const upload = onupload;
  if (!upload) return;
  event.preventDefault();
  if (disabled || uploading) return;
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  uploading = true;
  uploadError = null;
  try {
    const uploaded = await upload(files);
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

/** `keepListening`: a hands-free send on pause keeps the microphone on so the
 * conversation can go on; pressing Send or Enter ends dictation. */
async function handleSend(keepListening = false) {
  if (disabled || sending) return;
  cancelAutoSend();
  // End dictation and wait for its last words before the draft is read.
  if (dictation.active && !keepListening) {
    await dictation.stop();
    await dictation.whenSettled();
  }
  const trimmed = content.trim();
  if (!trimmed || disabled || sending) return;
  sendError = null;
  sending = true;
  // The sent text leaves the box as soon as the send starts, so a manual or
  // automatic send never leaves it sitting there for the whole reply, and
  // anything said or typed meanwhile lands in a fresh box. A failed send puts
  // it back (#2904 review finding 4: never lose the message on failure).
  const sentAttachments = stagedAttachments;
  content = '';
  stagedAttachments = [];
  if (textareaEl) textareaEl.style.height = 'auto';
  try {
    await onsend(trimmed, sentAttachments);
  } catch (error) {
    const newer = content.trim();
    content = newer ? `${trimmed}\n${newer}` : trimmed;
    stagedAttachments = [...sentAttachments, ...stagedAttachments];
    sendError =
      error instanceof Error
        ? error.message
        : t(M['chat.assistant_composer.send_failed']);
  } finally {
    sending = false;
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && (dictation.active || sendDictated)) {
    event.preventDefault();
    cancelAutoSend();
    if (dictation.active) void dictation.stop();
    return;
  }
  // Typing means the person has taken over: no automatic send.
  if (event.key.length === 1 || event.key === 'Backspace') cancelAutoSend();
  // Matches ../messages/MessageInput.svelte's handleKeydown convention:
  // plain Enter sends, Shift+Enter inserts a newline. `isComposing` guards
  // against an IME's confirmation Enter being treated as a send.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void handleSend();
  }
}

function handleInput(event: Event) {
  const el = event.currentTarget as HTMLTextAreaElement;
  textareaEl = el;
  resize(el);
}

function removeAttachment(id: string) {
  stagedAttachments = stagedAttachments.filter((a) => a.id !== id);
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="assistant-composer"
  ondrop={onupload ? handleDrop : undefined}
  ondragover={onupload ? (event) => event.preventDefault() : undefined}
>
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
  {#if canDictate}
    <DictationStatus {dictation} sending={autoSendCountdown || autoSendWaiting} />
  {/if}
  <div class="assistant-composer-row">
    {#if onupload}
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
    {/if}
    <div
      class="assistant-composer-field"
      use:longPress={{
        onPressStart: () => primeReadyBeep(),
        onLongPress: startDictationFromHold,
        onRelease: () => void dictation.unlock(),
        disabled: !canDictate || disabled || uploading,
      }}
    >
      <Textarea
        bind:this={textareaComponent}
        bind:value={content}
        class="assistant-composer-textarea"
        {placeholder}
        disabled={disabled || uploading}
        rows={1}
        onkeydown={handleKeydown}
        oninput={handleInput}
        aria-label={t(M['chat.assistant_composer.message_label'])}
      />
    </div>
    {#if canDictate}
      <DictationButton {dictation} disabled={disabled || uploading} />
    {/if}
    <Button
      type="button"
      class="assistant-composer-send"
      onclick={() => handleSend()}
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
    container-type: inline-size;
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
    width: 44px;
    height: 44px;
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

  .assistant-composer-field {
    flex: 1;
    display: flex;
    min-inline-size: 0;
  }

  :global(.assistant-composer-textarea) {
    flex: 1;
    resize: none;
    /* #3000: form controls don't inherit font; use the theme's family. */
    font-family: var(--smrt-font-family, inherit);
  }

  /* Phones: 16px text so iOS Safari doesn't zoom the page when the
     message field gets focus. */
  @media (max-width: 48rem) {
    :global(.assistant-composer-textarea) {
      font-size: max(1rem, 16px);
    }
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

  /* A narrow dock (a sidebar a couple of hundred pixels wide): the message
     field takes the whole row and the attach, dictate and send controls sit
     under it, so the placeholder never wraps a syllable per line. */
  @container (max-width: 22rem) {
    .assistant-composer-row {
      flex-wrap: wrap;
    }

    .assistant-composer-field {
      flex: 1 1 100%;
      order: -1;
    }

    :global(.assistant-composer-send) {
      margin-inline-start: auto;
    }
  }
</style>
