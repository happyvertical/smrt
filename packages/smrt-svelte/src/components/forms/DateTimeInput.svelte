<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import { useSTT } from '../../hooks/useSTT.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import { importOptional } from '../../utils/import-optional.js';

export interface Props {
  /** Field name */
  name: string;
  /** Field label */
  label?: string;
  /** Description for LLM field extraction */
  description?: string;
  /** Include time in the picker */
  includeTime?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Current value (ISO format, bindable) */
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
  includeTime = true,
  placeholder = includeTime
    ? 'e.g., next Tuesday at 3pm'
    : 'e.g., March 15, 1990',
  value = $bindable(''),
  disabled = false,
  required = false,
  onchange,
}: Props = $props();

const app = useAppState();
const stt = useSTT();
const formContext = tryGetFormContext();

let inputEl: HTMLInputElement | null = $state(null);
let displayValue = $state('');
let isHolding = $state(false);
let isParsing = $state(false);
let parseError = $state<string | null>(null);
let spokenText = $state('');
let recordingStartTime = 0;

// Minimum hold time in ms before processing (prevents accidental clicks)
const MIN_HOLD_TIME = 500;
// Minimum transcript length to process
const MIN_TRANSCRIPT_LENGTH = 2;

// Check if we're in smrt mode
const isSmrt = $derived(app.state.mode === 'smrt');

// Helper to update value (works with $bindable)
function updateValue(newValue: string) {
  value = newValue;
  onchange?.(value);
}

// Format ISO date for display
function formatForDisplay(isoValue: string): string {
  if (!isoValue) return '';
  try {
    // For date-only strings (YYYY-MM-DD), parse components directly
    // to avoid JavaScript's UTC interpretation bug
    if (!includeTime && /^\d{4}-\d{2}-\d{2}$/.test(isoValue)) {
      const [year, month, day] = isoValue.split('-').map(Number);
      const date = new Date(year, month - 1, day); // Local date
      return date.toLocaleDateString(undefined, { dateStyle: 'medium' });
    }

    // For datetime strings, parse normally
    const date = new Date(isoValue);
    if (Number.isNaN(date.getTime())) return isoValue;

    if (includeTime) {
      return date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } else {
      return date.toLocaleDateString(undefined, {
        dateStyle: 'medium',
      });
    }
  } catch {
    return isoValue;
  }
}

// Update display when value changes
$effect(() => {
  displayValue = formatForDisplay(value);
});

// Register with form context
onMount(() => {
  if (formContext) {
    const fieldDef: FieldDefinition = {
      name,
      type: 'datetime',
      label,
      description: description ?? (includeTime ? 'Date and time' : 'Date'),
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

// Parse natural language to ISO date using chrono-node (no LLM needed)
async function parseNaturalLanguage(text: string): Promise<string> {
  // Dynamically import chrono-node only when needed
  let chrono: typeof import('chrono-node');
  try {
    chrono = await importOptional<typeof import('chrono-node')>('chrono-node');
  } catch {
    throw new Error(
      'Natural-language date parsing requires the optional dependency "chrono-node". Install it with: pnpm add chrono-node',
    );
  }

  // Use chrono-node to parse natural language dates
  const results = chrono.parse(text);

  if (results.length === 0) {
    throw new Error('Could not parse date from speech');
  }

  const parsed = results[0].start.date();

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid date');
  }

  // Format as local date (not UTC) to avoid day-off-by-one issues
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');

  if (includeTime) {
    const hours = String(parsed.getHours()).padStart(2, '0');
    const minutes = String(parsed.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  } else {
    return `${year}-${month}-${day}`;
  }
}

// No live transcript - just show "Recording..." to avoid state pollution
// The full audio will be processed by STT after recording stops

async function startHoldRecording() {
  if (!isSmrt || disabled || isParsing) return;

  // Initialize STT with Whisper v2 for speed + accuracy
  if (!stt.isReady || stt.adapterType !== 'whisper-wasm') {
    await stt.initialize({ type: 'whisper-wasm' });
  }

  parseError = null;
  recordingStartTime = Date.now();
  isHolding = true;

  // Use continuous mode to capture all speech while holding
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
    parseError = 'No speech detected. Hold longer and speak clearly.';
    return;
  }

  // Parse the spoken text using chrono-node
  isParsing = true;
  parseError = null;

  try {
    const isoDate = await parseNaturalLanguage(finalTranscript);
    updateValue(isoDate);
  } catch (err) {
    parseError = err instanceof Error ? err.message : 'Failed to parse date';
  } finally {
    isParsing = false;
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

function handleNativeChange(e: Event) {
  const target = e.target as HTMLInputElement;
  updateValue(target.value);
}
</script>

<div class="smrt-datetime" class:listening={isHolding} class:parsing={isParsing}>
  {#if label}
    <label for={name} class="smrt-label">
      {label}
      {#if required}<span class="required">*</span>{/if}
    </label>
  {/if}

  <div class="input-wrapper">
    {#if isSmrt}
      <!-- In SMRT mode: text input with voice -->
      <input
        bind:this={inputEl}
        id={name}
        name={name}
        type="text"
        placeholder={placeholder}
        value={displayValue}
        disabled={disabled || isParsing}
        {required}
        class="smrt-input smrt-mode"
        readonly
        onmousedown={handleMouseDown}
        onmouseup={handleMouseUp}
        onmouseleave={handleMouseLeave}
        ontouchstart={handleTouchStart}
        ontouchend={handleTouchEnd}
      />

      <button
        type="button"
        class="mic-btn"
        class:active={isHolding}
        disabled={disabled || isParsing}
        onclick={handleMicClick}
        onmousedown={handleMicMouseDown}
        onmouseup={handleMouseUp}
        onmouseleave={handleMouseLeave}
        ontouchstart={handleMicTouchStart}
        ontouchend={handleTouchEnd}
        aria-label="Hold to speak"
      >
        {#if isParsing}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="spinner"
          >
            <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/>
          </svg>
        {:else}
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
        {/if}
      </button>
    {:else}
      <!-- In default mode: native datetime picker -->
      <input
        bind:this={inputEl}
        id={name}
        name={name}
        type={includeTime ? 'datetime-local' : 'date'}
        value={value}
        {disabled}
        {required}
        class="smrt-input"
        onchange={handleNativeChange}
      />
    {/if}
  </div>

  {#if isHolding}
    <div class="listening-indicator">Recording...</div>
  {:else if isParsing}
    <div class="parsing-indicator">Parsing date...</div>
  {:else if parseError}
    <div class="error-indicator">{parseError}</div>
  {/if}
</div>

<style>
  .smrt-datetime {
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: relative;
  }

  .smrt-label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-body-medium-weight, 500);
    color: var(--smrt-color-on-surface, #374151);
  }

  .smrt-label .required {
    color: var(--smrt-color-error, #ba1a1a);
    margin-left: 2px;
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
    padding-right: 44px;
    cursor: pointer;
  }

  .smrt-input:disabled {
    background: var(--smrt-color-surface-container-high, #f3f4f6);
    cursor: not-allowed;
  }

  .smrt-datetime.listening .smrt-input {
    border-color: var(--smrt-color-success, #22c55e);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-success, #22c55e) 30%, transparent);
    animation: pulse-green 1.5s var(--smrt-easing-standard, ease-in-out) infinite;
  }

  .smrt-datetime.parsing .smrt-input {
    border-color: var(--smrt-color-warning, #f59e0b);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-warning, #f59e0b) 20%, transparent);
  }

  @keyframes pulse-green {
    0%, 100% {
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-success, #22c55e) 30%, transparent);
    }
    50% {
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--smrt-color-success, #22c55e) 15%, transparent);
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
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
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

  .spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }

  .listening-indicator {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-primary, #22c55e);
    margin-top: 2px;
  }

  .parsing-indicator {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-secondary, #f59e0b);
    margin-top: 2px;
  }

  .error-indicator {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-error, #ba1a1a);
    margin-top: 2px;
  }
</style>
