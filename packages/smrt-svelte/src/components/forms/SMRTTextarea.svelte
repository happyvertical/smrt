<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import { useSTT } from '../../hooks/useSTT.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';

interface Props {
  /** Field name */
  name: string;
  /** Field label */
  label?: string;
  /** Description for voice extraction */
  description?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Current value (bindable) */
  value?: string;
  /** Number of rows */
  rows?: number;
  /** Disabled state */
  disabled?: boolean;
  /** Required field */
  required?: boolean;
  /** Append to existing value instead of overwriting */
  appendMode?: boolean;
  /** Called when value changes */
  onchange?: (value: string) => void;
}

let {
  name,
  label,
  description,
  placeholder = '',
  value = $bindable(''),
  rows = 4,
  disabled = false,
  required = false,
  appendMode = false,
  onchange,
}: Props = $props();

const app = useAppState();
const stt = useSTT();
const formContext = tryGetFormContext();

let textareaEl: HTMLTextAreaElement | null = $state(null);
let isHolding = $state(false);
let isProcessing = $state(false);
let valueBeforeRecording = '';
let processError = $state<string | null>(null);
let recordingStartTime = 0;

const MIN_HOLD_TIME = 500;
const MIN_TRANSCRIPT_LENGTH = 2;

const isSmrt = $derived(app.state.mode === 'smrt');
const isInitializing = $derived(stt.isInitializing);
const downloadProgress = $derived(stt.downloadProgress);

function updateValue(newValue: string) {
  value = newValue;
  onchange?.(value);
}

// Register with form context
onMount(() => {
  if (formContext) {
    const fieldDef: FieldDefinition = {
      name,
      type: 'textarea',
      label,
      description,
      setValue: (v: unknown) => {
        if (appendMode && value) {
          updateValue(`${value}\n${String(v ?? '')}`);
        } else {
          updateValue(String(v ?? ''));
        }
      },
      getValue: () => value,
    };
    formContext.registerField(fieldDef);
  }
});

onDestroy(() => {
  if (formContext) {
    formContext.unregisterField(name);
  }
});

function formatValue(transcript: string): string {
  return transcript.replace(/^(um|uh|like|so|well)\s*/gi, '').trim();
}

async function startHoldRecording() {
  if (!isSmrt || disabled || isProcessing) return;

  if (!stt.isReady || stt.adapterType !== 'whisper-wasm') {
    await stt.initialize({ type: 'whisper-wasm' });
  }

  valueBeforeRecording = value;
  processError = null;
  recordingStartTime = Date.now();
  isHolding = true;

  await stt.start({ continuous: true, interimResults: false });
}

async function stopHoldRecording() {
  if (!isHolding) return;

  const holdDuration = Date.now() - recordingStartTime;
  isHolding = false;
  await stt.stop();

  if (holdDuration < MIN_HOLD_TIME) {
    return;
  }

  const maxWait = 3000;
  const startWait = Date.now();
  while (stt.isListening && Date.now() - startWait < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));

  const finalTranscript = stt.lastResult?.trim() || '';

  if (!finalTranscript || finalTranscript.length < MIN_TRANSCRIPT_LENGTH) {
    processError = 'No speech detected. Hold longer and speak clearly.';
    return;
  }

  isProcessing = true;
  processError = null;

  try {
    const formattedValue = formatValue(finalTranscript);

    if (appendMode && valueBeforeRecording) {
      updateValue(`${valueBeforeRecording}\n${formattedValue}`);
    } else {
      updateValue(formattedValue);
    }
  } catch (err) {
    processError =
      err instanceof Error ? err.message : 'Failed to process speech';
  } finally {
    isProcessing = false;
  }
}

function handleMouseDown(e: MouseEvent) {
  if (e.button !== 0) return;
  startHoldRecording();
}

function handleMouseUp() {
  stopHoldRecording();
}

function handleMouseLeave() {
  stopHoldRecording();
}

function handleTouchStart(e: TouchEvent) {
  e.preventDefault();
  startHoldRecording();
}

function handleTouchEnd() {
  stopHoldRecording();
}

function handleInput(e: Event) {
  const target = e.target as HTMLTextAreaElement;
  updateValue(target.value);
}
</script>

<div class="smrt-textarea" class:listening={isHolding}>
  {#if label}
    <label for={name} class="smrt-label">
      {label}
      {#if required}<span class="required">*</span>{/if}
    </label>
  {/if}

  <div class="textarea-wrapper">
    <textarea
      bind:this={textareaEl}
      id={name}
      {name}
      {placeholder}
      {value}
      {rows}
      disabled={disabled || isProcessing}
      {required}
      class="smrt-textarea-input"
      class:smrt-mode={isSmrt}
      class:processing={isProcessing}
      oninput={handleInput}
      onmousedown={isSmrt ? handleMouseDown : undefined}
      onmouseup={isSmrt ? handleMouseUp : undefined}
      onmouseleave={isSmrt ? handleMouseLeave : undefined}
      ontouchstart={isSmrt ? handleTouchStart : undefined}
      ontouchend={isSmrt ? handleTouchEnd : undefined}
    ></textarea>

    {#if isSmrt}
      <button
        type="button"
        class="mic-btn"
        class:active={isHolding}
        {disabled}
        onmousedown={handleMouseDown}
        onmouseup={handleMouseUp}
        onmouseleave={handleMouseLeave}
        ontouchstart={handleTouchStart}
        ontouchend={handleTouchEnd}
        aria-label="Hold to speak"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" x2="12" y1="19" y2="22"/>
        </svg>
      </button>
    {/if}
  </div>

  {#if isInitializing}
    <div class="downloading-indicator">
      <span class="processing-spinner"></span>
      <span>Downloading Whisper model... {downloadProgress}%</span>
    </div>
  {:else if isHolding}
    <div class="listening-indicator">
      <span class="listening-dot"></span>
      <span>Recording...</span>
    </div>
  {:else if isProcessing}
    <div class="processing-indicator">
      <span class="processing-spinner"></span>
      <span>Processing...</span>
    </div>
  {/if}

  {#if processError}
    <div class="error-message">{processError}</div>
  {/if}
</div>

<style>
  .smrt-textarea {
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: relative;
  }

  .smrt-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: #374151;
  }

  .smrt-label .required {
    color: #ef4444;
    margin-left: 2px;
  }

  .textarea-wrapper {
    display: flex;
    position: relative;
  }

  .smrt-textarea-input {
    flex: 1;
    padding: 8px 12px;
    font-size: 1rem;
    font-family: inherit;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: #fff;
    resize: vertical;
    min-height: 80px;
    transition: all 0.2s;
  }

  .smrt-textarea-input:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  .smrt-textarea-input.smrt-mode {
    padding-right: 44px;
  }

  .smrt-textarea-input:disabled {
    background: #f3f4f6;
    cursor: not-allowed;
  }

  .smrt-textarea.listening .smrt-textarea-input {
    border-color: #22c55e;
    box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.3);
    animation: pulse-green 1.5s ease-in-out infinite;
  }

  @keyframes pulse-green {
    0%, 100% {
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.3);
    }
    50% {
      box-shadow: 0 0 0 6px rgba(34, 197, 94, 0.15);
    }
  }

  .mic-btn {
    position: absolute;
    right: 4px;
    top: 8px;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: #6b7280;
    cursor: pointer;
    transition: all 0.2s;
  }

  .mic-btn:hover {
    background: #f3f4f6;
    color: #374151;
  }

  .mic-btn.active {
    background: #22c55e;
    color: white;
  }

  .mic-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .smrt-textarea-input.processing {
    opacity: 0.7;
  }

  .listening-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.75rem;
    color: #22c55e;
    margin-top: 4px;
  }

  .listening-dot {
    width: 8px;
    height: 8px;
    background: #22c55e;
    border-radius: 50%;
    animation: pulse-dot 1s ease-in-out infinite;
  }

  @keyframes pulse-dot {
    0%, 100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.5;
      transform: scale(0.8);
    }
  }

  .processing-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.75rem;
    color: #6b7280;
    margin-top: 4px;
  }

  .downloading-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.75rem;
    color: #8b5cf6;
    margin-top: 4px;
  }

  .processing-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid #e5e7eb;
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error-message {
    font-size: 0.75rem;
    color: #f97316;
    margin-top: 4px;
  }
</style>
