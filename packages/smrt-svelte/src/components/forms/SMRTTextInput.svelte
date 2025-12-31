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
  /** Description for LLM field extraction */
  description?: string;
  /** Input type */
  type?: 'text' | 'email';
  /** Placeholder text */
  placeholder?: string;
  /** Current value (bindable) */
  value?: string;
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
  type = 'text',
  placeholder = '',
  value = $bindable(''),
  disabled = false,
  required = false,
  appendMode = false,
  onchange,
}: Props = $props();

const app = useAppState();
const stt = useSTT();
const formContext = tryGetFormContext();

let inputEl: HTMLInputElement | null = $state(null);
let isHolding = $state(false);
let isProcessing = $state(false);
let valueBeforeRecording = '';
let processError = $state<string | null>(null);
let recordingStartTime = 0;

// Minimum hold time in ms before processing (prevents accidental clicks)
const MIN_HOLD_TIME = 500;
// Minimum transcript length to process
const MIN_TRANSCRIPT_LENGTH = 2;

// Check if we're in smrt mode
const isSmrt = $derived(app.state.mode === 'smrt');

// Track STT initialization and download progress
const isInitializing = $derived(stt.isInitializing);
const downloadProgress = $derived(stt.downloadProgress);

// Validation
const isValidEmail = $derived.by(() => {
  if (type !== 'email' || !value) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
});
const showInvalid = $derived(type === 'email' && value && !isValidEmail);

// Helper to update value (works with $bindable)
function updateValue(newValue: string) {
  value = newValue;
  onchange?.(value);
}

// Register with form context
onMount(() => {
  if (formContext) {
    const fieldDef: FieldDefinition = {
      name,
      type: type === 'email' ? 'email' : 'text',
      label,
      description,
      setValue: (v: unknown) => {
        updateValue(String(v ?? ''));
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

// Format the spoken text for the field type
// Using pure JavaScript - no LLM needed for simple formatting
function formatValue(transcript: string): string {
  if (type === 'email') {
    // Convert spoken email to actual email format
    return transcript
      .toLowerCase()
      .replace(/\s+at\s+/gi, '@')
      .replace(/\bat\b/gi, '@')
      .replace(/\s+dot\s+/gi, '.')
      .replace(/\bdot\b/gi, '.')
      .replace(/\s+/g, '') // Remove all remaining spaces
      .trim();
  } else {
    // For name/text: just clean up filler words
    return transcript
      .replace(/^(my name is|i am|i'm|it's|this is|the name is)\s*/i, '')
      .replace(/^(um|uh|like|so|well)\s*/gi, '')
      .trim();
  }
}

// Simple processing - just format, no LLM needed
function processTranscript(transcript: string): string {
  return formatValue(transcript);
}

// No live transcript - just show "Recording..." to avoid state pollution
// The full audio will be processed by STT after recording stops

async function startHoldRecording() {
  if (!isSmrt || disabled || isProcessing) return;

  // Initialize STT with Whisper v2 for speed + accuracy
  if (!stt.isReady || stt.adapterType !== 'whisper-wasm') {
    await stt.initialize({ type: 'whisper-wasm' });
  }

  // Store current value for append mode
  valueBeforeRecording = value;
  processError = null;
  recordingStartTime = Date.now();
  isHolding = true;

  // Use continuous mode to capture all speech while holding
  // interimResults: false means we only get final results
  await stt.start({ continuous: true, interimResults: false });
}

async function stopHoldRecording() {
  if (!isHolding) return;

  // Calculate hold duration
  const holdDuration = Date.now() - recordingStartTime;

  isHolding = false;
  await stt.stop();

  // Check minimum hold time - ignore quick clicks
  if (holdDuration < MIN_HOLD_TIME) {
    return;
  }

  // Wait for STT to fully stop processing (isListening becomes false when onend fires)
  // This is more reliable than a fixed timeout
  const maxWait = 3000; // 3 seconds max wait
  const startWait = Date.now();
  while (stt.isListening && Date.now() - startWait < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Additional small delay to ensure lastResult is updated
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Get the final transcript
  const finalTranscript = stt.lastResult?.trim() || '';

  if (!finalTranscript || finalTranscript.length < MIN_TRANSCRIPT_LENGTH) {
    processError = 'No speech detected. Hold longer and speak clearly.';
    return;
  }

  // Process through extract + validate pipeline
  isProcessing = true;
  processError = null;

  try {
    const validatedValue = await processTranscript(finalTranscript);

    if (appendMode && valueBeforeRecording) {
      updateValue(`${valueBeforeRecording} ${validatedValue}`);
    } else {
      updateValue(validatedValue);
    }
  } catch (err) {
    processError =
      err instanceof Error ? err.message : 'Failed to process speech';
  } finally {
    isProcessing = false;
  }
}

function handleMouseDown(e: MouseEvent) {
  // Left click only
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
  e.preventDefault(); // Prevent text selection
  startHoldRecording();
}

function handleTouchEnd() {
  stopHoldRecording();
}

function handleMicClick(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

function handleMicMouseDown(e: MouseEvent) {
  e.stopPropagation();
  if (e.button !== 0) return;
  startHoldRecording();
}

function handleMicTouchStart(e: TouchEvent) {
  e.stopPropagation();
  e.preventDefault();
  startHoldRecording();
}

function handleInput(e: Event) {
  const target = e.target as HTMLInputElement;
  updateValue(target.value);
}
</script>

<div class="smrt-text-input" class:listening={isHolding}>
  {#if label}
    <label for={name} class="smrt-label">
      {label}
      {#if required}<span class="required">*</span>{/if}
    </label>
  {/if}

  <div class="input-wrapper">
    <input
      bind:this={inputEl}
      id={name}
      {name}
      type={type}
      {placeholder}
      {value}
      disabled={disabled || isProcessing}
      {required}
      class="smrt-input"
      class:smrt-mode={isSmrt}
      class:invalid={showInvalid}
      class:processing={isProcessing}
      oninput={handleInput}
      onmousedown={isSmrt ? handleMouseDown : undefined}
      onmouseup={isSmrt ? handleMouseUp : undefined}
      onmouseleave={isSmrt ? handleMouseLeave : undefined}
      ontouchstart={isSmrt ? handleTouchStart : undefined}
      ontouchend={isSmrt ? handleTouchEnd : undefined}
    />

    {#if isSmrt}
      <button
        type="button"
        class="mic-btn"
        class:active={isHolding}
        {disabled}
        onclick={handleMicClick}
        onmousedown={handleMicMouseDown}
        onmouseup={handleMouseUp}
        onmouseleave={handleMouseLeave}
        ontouchstart={handleMicTouchStart}
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

  {#if showInvalid}
    <div class="validation-error">Invalid email address</div>
  {/if}
</div>

<style>
  .smrt-text-input {
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

  .input-wrapper {
    display: flex;
    position: relative;
  }

  .smrt-input {
    flex: 1;
    padding: 8px 12px;
    font-size: 1rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: #fff;
    transition: all 0.2s;
  }

  .smrt-input:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  .smrt-input.smrt-mode {
    padding-right: 44px;
    cursor: pointer;
  }

  .smrt-input:disabled {
    background: #f3f4f6;
    cursor: not-allowed;
  }

  .smrt-text-input.listening .smrt-input {
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
    top: 50%;
    transform: translateY(-50%);
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

  .smrt-input.invalid {
    border-color: #ef4444;
  }

  .smrt-input.invalid:focus {
    border-color: #ef4444;
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
  }

  .smrt-input.processing {
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

  .validation-error {
    font-size: 0.75rem;
    color: #ef4444;
    margin-top: 4px;
  }
</style>
