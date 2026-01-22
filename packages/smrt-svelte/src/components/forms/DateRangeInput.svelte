<script lang="ts">
import * as chrono from 'chrono-node';
import { onDestroy, onMount } from 'svelte';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import { useSTT } from '../../hooks/useSTT.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import type { DateRangeValue } from './types.js';

interface Props {
  /** Field name */
  name: string;
  /** Field label */
  label?: string;
  /** Description for voice extraction */
  description?: string;
  /** Start date placeholder */
  startPlaceholder?: string;
  /** End date placeholder */
  endPlaceholder?: string;
  /** Current start date (ISO format YYYY-MM-DD, bindable) */
  startDate?: string;
  /** Current end date (ISO format YYYY-MM-DD, bindable) */
  endDate?: string;
  /** Minimum selectable date */
  minDate?: string;
  /** Maximum selectable date */
  maxDate?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Required field */
  required?: boolean;
  /** Error message to display */
  error?: string;
  /** Called when value changes */
  onchange?: (value: DateRangeValue) => void;
}

let {
  name,
  label,
  description,
  startPlaceholder = 'Start date',
  endPlaceholder = 'End date',
  startDate = $bindable(''),
  endDate = $bindable(''),
  minDate,
  maxDate,
  disabled = false,
  required = false,
  error,
  onchange,
}: Props = $props();

const app = useAppState();
const stt = useSTT();
const formContext = tryGetFormContext();

const isSmrt = $derived(app.state.mode === 'smrt');

let isRecording = $state(false);
let isParsing = $state(false);
let parseError = $state<string | null>(null);
let recordingStartTime = 0;

const MIN_HOLD_TIME = 500;
const MIN_TRANSCRIPT_LENGTH = 2;

// Display values
let startDisplay = $state('');
let endDisplay = $state('');

// Format ISO date for display
function formatForDisplay(isoValue: string): string {
  if (!isoValue) return '';
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(isoValue)) {
      const [year, month, day] = isoValue.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      return date.toLocaleDateString(undefined, { dateStyle: 'medium' });
    }
    return isoValue;
  } catch {
    return isoValue;
  }
}

// Update displays when values change
$effect(() => {
  startDisplay = formatForDisplay(startDate);
  endDisplay = formatForDisplay(endDate);
});

// Validation
const isValidRange = $derived.by(() => {
  if (!startDate || !endDate) return true;
  return startDate <= endDate;
});
const showInvalid = $derived(!isValidRange || !!error);

function updateValue(start: string, end: string) {
  startDate = start;
  endDate = end;
  onchange?.({ startDate: start, endDate: end });
}

// Parse date range from natural language using chrono-node
function parseNaturalLanguageRange(
  text: string,
): { start: string; end: string } | null {
  console.log('[SMRTDateRange] Parsing text:', text);

  // Try to parse as a range first (e.g., "January 15th to March 30th")
  const rangePatterns = [
    /from\s+(.+?)\s+(?:to|until|through|till|-)\s+(.+)/i,
    /(.+?)\s+(?:to|until|through|till|-)\s+(.+)/i,
    /between\s+(.+?)\s+and\s+(.+)/i,
  ];

  for (const pattern of rangePatterns) {
    const match = text.match(pattern);
    if (match) {
      const startResults = chrono.parse(match[1]);
      const endResults = chrono.parse(match[2]);

      if (startResults.length > 0 && endResults.length > 0) {
        const startParsed = startResults[0].start.date();
        const endParsed = endResults[0].start.date();

        return {
          start: formatToISO(startParsed),
          end: formatToISO(endParsed),
        };
      }
    }
  }

  // Try to parse as multiple dates in the text
  const results = chrono.parse(text);
  if (results.length >= 2) {
    return {
      start: formatToISO(results[0].start.date()),
      end: formatToISO(results[1].start.date()),
    };
  }

  // Single date - use it as start date only
  if (results.length === 1) {
    return {
      start: formatToISO(results[0].start.date()),
      end: '',
    };
  }

  return null;
}

function formatToISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Register with form context
onMount(() => {
  if (formContext) {
    const fieldDef: FieldDefinition = {
      name,
      type: 'daterange',
      label,
      description:
        description ||
        'A date range with start and end dates (say "from [start] to [end]")',
      setValue: (v: unknown) => {
        if (v === null || v === undefined) {
          updateValue('', '');
          return;
        }
        if (typeof v === 'object' && v !== null) {
          const range = v as Partial<DateRangeValue>;
          updateValue(range.startDate || '', range.endDate || '');
          return;
        }
        // Try to parse spoken date range
        const parsed = parseNaturalLanguageRange(String(v));
        if (parsed) {
          updateValue(parsed.start, parsed.end);
        }
      },
      getValue: () => ({ startDate, endDate }),
    };
    formContext.registerField(fieldDef);
  }
});

onDestroy(() => {
  if (formContext) {
    formContext.unregisterField(name);
  }
});

async function startRecording() {
  if (!isSmrt || disabled || isParsing) return;

  if (!stt.isReady || stt.adapterType !== 'whisper-wasm') {
    await stt.initialize({ type: 'whisper-wasm' });
  }

  parseError = null;
  recordingStartTime = Date.now();
  isRecording = true;

  await stt.start({ continuous: true, interimResults: false });
}

async function stopRecording() {
  if (!isRecording) return;

  const holdDuration = Date.now() - recordingStartTime;
  isRecording = false;
  await stt.stop();

  if (holdDuration < MIN_HOLD_TIME) {
    return;
  }

  // Wait for STT to fully stop
  const maxWait = 3000;
  const startWait = Date.now();
  while (stt.isListening && Date.now() - startWait < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));

  const finalTranscript = stt.lastResult?.trim() || '';

  if (!finalTranscript || finalTranscript.length < MIN_TRANSCRIPT_LENGTH) {
    parseError =
      'No speech detected. Try saying "from January 15th to March 30th"';
    return;
  }

  isParsing = true;
  parseError = null;

  try {
    const parsed = parseNaturalLanguageRange(finalTranscript);
    if (parsed) {
      updateValue(parsed.start, parsed.end);
    } else {
      throw new Error('Could not parse date range');
    }
  } catch (err) {
    parseError =
      err instanceof Error ? err.message : 'Failed to parse date range';
  } finally {
    isParsing = false;
  }
}

function handleStartChange(e: Event) {
  const target = e.target as HTMLInputElement;
  updateValue(target.value, endDate);
}

function handleEndChange(e: Event) {
  const target = e.target as HTMLInputElement;
  updateValue(startDate, target.value);
}

function handleMouseDown(e: MouseEvent) {
  if (e.button !== 0) return;
  startRecording();
}

function handleMouseUp() {
  stopRecording();
}

function handleMouseLeave() {
  stopRecording();
}

function handleTouchStart(e: TouchEvent) {
  e.preventDefault();
  startRecording();
}

function handleTouchEnd() {
  stopRecording();
}
</script>

<div class="smrt-daterange" class:listening={isRecording} class:parsing={isParsing}>
  {#if label}
    <label class="smrt-label">
      {label}
      {#if required}<span class="required">*</span>{/if}
    </label>
  {/if}

  <div class="range-wrapper" class:smrt-mode={isSmrt} class:invalid={showInvalid}>
    {#if isSmrt}
      <!-- Voice mode: single input for the entire range -->
      <div class="voice-input-wrapper">
        <div class="voice-display">
          {#if startDisplay && endDisplay}
            <span class="date-value">{startDisplay}</span>
            <span class="range-separator">→</span>
            <span class="date-value">{endDisplay}</span>
          {:else if startDisplay}
            <span class="date-value">{startDisplay}</span>
            <span class="range-separator">→</span>
            <span class="placeholder">{endPlaceholder}</span>
          {:else}
            <span class="placeholder">Say "from [start] to [end]"</span>
          {/if}
        </div>

        <button
          type="button"
          class="mic-btn"
          class:active={isRecording}
          disabled={disabled || isParsing}
          onmousedown={handleMouseDown}
          onmouseup={handleMouseUp}
          onmouseleave={handleMouseLeave}
          ontouchstart={handleTouchStart}
          ontouchend={handleTouchEnd}
          aria-label="Hold to speak date range"
        >
          {#if isParsing}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinner">
              <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/>
            </svg>
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" x2="12" y1="19" y2="22"/>
            </svg>
          {/if}
        </button>
      </div>
    {:else}
      <!-- Standard mode: two date pickers -->
      <div class="date-inputs">
        <div class="date-field">
          <label for="{name}_start" class="field-label">Start</label>
          <input
            id="{name}_start"
            name="{name}[startDate]"
            type="date"
            value={startDate}
            min={minDate}
            max={endDate || maxDate}
            {disabled}
            required={required}
            class="smrt-input"
            onchange={handleStartChange}
          />
        </div>

        <span class="range-arrow">→</span>

        <div class="date-field">
          <label for="{name}_end" class="field-label">End</label>
          <input
            id="{name}_end"
            name="{name}[endDate]"
            type="date"
            value={endDate}
            min={startDate || minDate}
            max={maxDate}
            {disabled}
            required={required}
            class="smrt-input"
            onchange={handleEndChange}
          />
        </div>
      </div>
    {/if}

    <!-- Hidden inputs for form submission -->
    <input type="hidden" name="{name}_start" value={startDate} />
    <input type="hidden" name="{name}_end" value={endDate} />
  </div>

  {#if isRecording}
    <div class="listening-indicator">Recording... say "from [start] to [end]"</div>
  {:else if isParsing}
    <div class="parsing-indicator">Parsing dates...</div>
  {:else if parseError}
    <div class="error-indicator">{parseError}</div>
  {:else if error}
    <div class="error-indicator">{error}</div>
  {:else if !isValidRange}
    <div class="error-indicator">End date must be after start date</div>
  {/if}
</div>

<style>
  .smrt-daterange {
    display: flex;
    flex-direction: column;
    gap: 8px;
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

  .range-wrapper {
    display: flex;
    flex-direction: column;
  }

  .range-wrapper.smrt-mode {
    border: 1px solid #a855f7;
    border-radius: 6px;
    background: #faf5ff;
  }

  .range-wrapper.invalid {
    border-color: #ef4444;
  }

  .voice-input-wrapper {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    gap: 8px;
  }

  .voice-display {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 1rem;
  }

  .date-value {
    color: #374151;
  }

  .range-separator {
    color: #9ca3af;
    font-weight: 500;
  }

  .placeholder {
    color: #9ca3af;
    font-style: italic;
  }

  .date-inputs {
    display: flex;
    align-items: flex-end;
    gap: 12px;
  }

  .date-field {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .range-arrow {
    color: #9ca3af;
    font-size: 1.25rem;
    padding-bottom: 8px;
  }

  .smrt-input {
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

  .smrt-input:disabled {
    background: #f3f4f6;
    cursor: not-allowed;
  }

  .mic-btn {
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
    flex-shrink: 0;
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

  .spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .smrt-daterange.listening .range-wrapper.smrt-mode {
    border-color: #22c55e;
    box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.3);
    animation: pulse-green 1.5s ease-in-out infinite;
  }

  .smrt-daterange.parsing .range-wrapper.smrt-mode {
    border-color: #f59e0b;
    box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.2);
  }

  @keyframes pulse-green {
    0%, 100% {
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.3);
    }
    50% {
      box-shadow: 0 0 0 6px rgba(34, 197, 94, 0.15);
    }
  }

  .listening-indicator {
    font-size: 0.75rem;
    color: #22c55e;
  }

  .parsing-indicator {
    font-size: 0.75rem;
    color: #f59e0b;
  }

  .error-indicator {
    font-size: 0.75rem;
    color: #ef4444;
  }

  @media (max-width: 600px) {
    .date-inputs {
      flex-direction: column;
      gap: 8px;
    }

    .range-arrow {
      display: none;
    }
  }
</style>
