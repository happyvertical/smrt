<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import { useSTT } from '../../hooks/useSTT.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';

export interface Props {
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
  /** Disabled state */
  disabled?: boolean;
  /** Required field */
  required?: boolean;
  /** Called when value changes */
  onchange?: (value: string) => void;
}

let {
  name,
  label,
  description,
  placeholder = '(555) 555-5555',
  value = $bindable(''),
  disabled = false,
  required = false,
  onchange,
}: Props = $props();

const app = useAppState();
const stt = useSTT();
const formContext = tryGetFormContext();

let inputEl: HTMLInputElement | null = $state(null);
let isHolding = $state(false);
let isProcessing = $state(false);
let processError = $state<string | null>(null);
let recordingStartTime = 0;

const MIN_HOLD_TIME = 500;
const MIN_TRANSCRIPT_LENGTH = 2;

const isSmrt = $derived(app.state.mode === 'smrt');
const isInitializing = $derived(stt.isInitializing);
const downloadProgress = $derived(stt.downloadProgress);

// Phone validation (basic North American format)
const isValidPhone = $derived.by(() => {
  if (!value) return true;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 11;
});
const showInvalid = $derived(value && !isValidPhone);

function updateValue(newValue: string) {
  value = newValue;
  onchange?.(value);
}

// Format phone number as user types
function formatPhoneNumber(input: string): string {
  const digits = input.replace(/\D/g, '');

  if (digits.length === 0) return '';
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  if (digits.length <= 10)
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;

  // Handle 11-digit numbers (with country code)
  if (digits.length === 11 && digits[0] === '1') {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

// Parse spoken phone number
function parseSpokenPhone(text: string): string {
  const wordNumbers: Record<string, string> = {
    zero: '0',
    oh: '0',
    one: '1',
    two: '2',
    to: '2',
    too: '2',
    three: '3',
    four: '4',
    for: '4',
    five: '5',
    six: '6',
    seven: '7',
    eight: '8',
    nine: '9',
    niner: '9',
  };

  let result = text
    .toLowerCase()
    // Remove filler words
    .replace(
      /^(my phone number is|my number is|phone number|number is|call me at)\s*/i,
      '',
    )
    .replace(/\b(area code|extension|ext)\b/gi, '')
    .trim();

  // Replace word numbers with digits
  for (const [word, digit] of Object.entries(wordNumbers)) {
    result = result.replace(new RegExp(`\\b${word}\\b`, 'gi'), digit);
  }

  // Handle "double" and "triple"
  result = result.replace(/\bdouble\s*(\d)/gi, '$1$1');
  result = result.replace(/\btriple\s*(\d)/gi, '$1$1$1');

  // Extract just digits
  const digits = result.replace(/\D/g, '');

  return formatPhoneNumber(digits);
}

// Register with form context
onMount(() => {
  if (formContext) {
    const fieldDef: FieldDefinition = {
      name,
      type: 'phone',
      label,
      description: description || 'Phone number',
      setValue: (v: unknown) => {
        const strVal = String(v ?? '');
        const formatted = parseSpokenPhone(strVal);
        updateValue(formatted);
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

async function startHoldRecording() {
  if (!isSmrt || disabled || isProcessing) return;

  if (!stt.isReady || stt.adapterType !== 'whisper-wasm') {
    await stt.initialize({ type: 'whisper-wasm' });
  }

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

  if (holdDuration < MIN_HOLD_TIME) return;

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
    const formatted = parseSpokenPhone(finalTranscript);
    updateValue(formatted);
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
  const target = e.target as HTMLInputElement;
  const formatted = formatPhoneNumber(target.value);
  updateValue(formatted);
}
</script>

<div class="smrt-phone" class:listening={isHolding}>
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
      type="tel"
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

  {#if showInvalid}
    <div class="validation-error">Invalid phone number</div>
  {/if}
</div>

<style>
  .smrt-phone {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    position: relative;
  }

  .smrt-label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-body-medium-weight, 500);
    color: var(--smrt-color-on-surface, #374151);
  }

  .smrt-label .required {
    color: var(--smrt-color-error, #ba1a1a);
    margin-left: var(--smrt-spacing-1, 4px);
  }

  .input-wrapper {
    display: flex;
    position: relative;
  }

  .smrt-input {
    flex: 1;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    font-size: var(--smrt-typography-body-large-size, 1rem);
    border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
    border-radius: var(--smrt-radius-small, 6px);
    background: var(--smrt-color-surface, #fff);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .smrt-input:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary, #005ac1) 10%, transparent);
  }

  .smrt-input.smrt-mode {
    padding-right: var(--smrt-spacing-11, 44px);
    cursor: pointer;
  }

  .smrt-input:disabled {
    background: var(--smrt-color-surface-container-high, #f3f4f6);
    cursor: not-allowed;
  }

  .smrt-phone.listening .smrt-input {
    border-color: var(--smrt-color-success, #22c55e);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-success, #22c55e) 30%, transparent);
    animation: pulse-green 1.5s var(--smrt-easing-standard, ease-in-out) infinite;
  }

  @keyframes pulse-green {
    0%, 100% {
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-success, #22c55e) 30%, transparent);
    }
    50% {
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--smrt-color-success, #22c55e) 15%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .smrt-phone.listening .smrt-input {
      animation: none;
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
    color: var(--smrt-color-on-surface-variant, #6b7280);
    cursor: pointer;
    transition: all 0.2s;
  }

  .mic-btn:hover {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface, #374151);
  }

  .mic-btn.active {
    background: var(--smrt-color-primary, #22c55e);
    color: var(--smrt-color-on-primary, white);
  }

  .mic-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .smrt-input.invalid {
    border-color: var(--smrt-color-error, #ba1a1a);
  }

  .smrt-input.invalid:focus {
    border-color: var(--smrt-color-error, #ba1a1a);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-error, #ba1a1a) 10%, transparent);
  }

  .smrt-input.processing {
    opacity: 0.7;
  }

  .listening-indicator {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-success);
    margin-top: var(--smrt-spacing-1, 4px);
  }

  .listening-dot {
    width: 8px;
    height: 8px;
    background: var(--smrt-color-success);
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

  @media (prefers-reduced-motion: reduce) {
    .listening-dot {
      animation: none;
    }
  }

  .processing-indicator {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
    margin-top: var(--smrt-spacing-1, 4px);
  }

  .downloading-indicator {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-tertiary);
    margin-top: var(--smrt-spacing-1, 4px);
  }

  .processing-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--smrt-color-outline-variant);
    border-top-color: var(--smrt-color-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error-message {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-error, #f97316);
    margin-top: var(--smrt-spacing-1, 4px);
  }

  .validation-error {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-error, #ba1a1a);
    margin-top: var(--smrt-spacing-1, 4px);
  }
</style>
