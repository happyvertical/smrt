<script lang="ts">
import { FieldLabel } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import { useSTT } from '../../hooks/useSTT.svelte.js';
import { M } from '../../i18n/strings.forms.js';
import { logger } from '../../internal/logger.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import { invalidStagedValue } from './prepare-field-value.js';
import type { DateRangeValue } from './types.js';

const { t } = useI18n();

export interface Props {
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
const fieldOwnerId = $props.id();
const fieldOwnerToken = `smrt-rich-field-${fieldOwnerId}`;

const isSmrt = $derived(app.state.mode === 'smrt');

let isRecording = $state(false);
let isParsing = $state(false);
let parseError = $state<string | null>(null);
let recordingStartTime = 0;
let primaryControl = $state<HTMLElement | null>(null);

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
async function parseNaturalLanguageRange(
  text: string,
): Promise<{ start: string; end: string } | null> {
  // Dynamically import chrono-node only when needed
  let chrono: typeof import('chrono-node');
  try {
    chrono = await import('chrono-node');
  } catch {
    throw new Error(
      'Natural-language date parsing requires the optional dependency "chrono-node". Install it with: pnpm add chrono-node',
    );
  }

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

function isCanonicalCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// Register with form context
$effect(() => {
  if (formContext) {
    const registeredName = name;
    const fieldDef: FieldDefinition = {
      name: registeredName,
      ownerToken: fieldOwnerToken,
      type: 'daterange',
      get label() {
        return label;
      },
      get description() {
        return (
          description ||
          'A date range with start and end dates (say "from [start] to [end]")'
        );
      },
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
        parseNaturalLanguageRange(String(v))
          .then((parsed) => {
            if (parsed) {
              updateValue(parsed.start, parsed.end);
            }
          })
          .catch(() => {});
      },
      getValue: () => ({ startDate, endDate }),
      prepareValue: (candidate) => {
        if (candidate === null || candidate === undefined) {
          return { startDate: '', endDate: '' };
        }
        if (
          typeof candidate !== 'object' ||
          Array.isArray(candidate) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(candidate))
        ) {
          return invalidStagedValue();
        }
        return candidate;
      },
      prepareExtractedValue: async (candidate) => {
        if (typeof candidate !== 'string') {
          return invalidStagedValue();
        }
        const parsed = await parseNaturalLanguageRange(candidate);
        if (!parsed) {
          return invalidStagedValue();
        }
        return { startDate: parsed.start, endDate: parsed.end };
      },
      clear: () => {
        updateValue('', '');
        return true;
      },
      getState: () => ({
        disabled: disabled || primaryControl?.matches(':disabled') === true,
      }),
      get constraints() {
        return { required };
      },
      focus: () => primaryControl?.focus(),
      get webMcpSchema() {
        return {
          type: 'object',
          additionalProperties: false,
          properties: {
            startDate: {
              type: 'string',
              format: 'date',
              ...(minDate ? { formatMinimum: minDate } : {}),
              ...(maxDate ? { formatMaximum: maxDate } : {}),
            },
            endDate: {
              type: 'string',
              format: 'date',
              ...(minDate ? { formatMinimum: minDate } : {}),
              ...(maxDate ? { formatMaximum: maxDate } : {}),
            },
          },
          ...(required ? { required: ['startDate', 'endDate'] } : {}),
        };
      },
      validateValue: (candidate) => {
        if (candidate === null || candidate === undefined) return !required;
        if (
          typeof candidate !== 'object' ||
          Array.isArray(candidate) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(candidate))
        ) {
          return false;
        }
        const range = candidate as Record<string, unknown>;
        if (
          !Object.keys(range).every((key) =>
            ['startDate', 'endDate'].includes(key),
          ) ||
          !Object.hasOwn(range, 'startDate') ||
          !Object.hasOwn(range, 'endDate') ||
          typeof range.startDate !== 'string' ||
          typeof range.endDate !== 'string'
        ) {
          return false;
        }
        const start = range.startDate;
        const end = range.endDate;
        if (required && (!start || !end)) return false;
        if (
          (start && !isCanonicalCalendarDate(start)) ||
          (end && !isCanonicalCalendarDate(end)) ||
          (start && minDate && start < minDate) ||
          (start && maxDate && start > maxDate) ||
          (end && minDate && end < minDate) ||
          (end && maxDate && end > maxDate) ||
          (start && end && start > end)
        ) {
          return false;
        }
        return true;
      },
      validate: () =>
        !required || (startDate.trim().length > 0 && endDate.trim().length > 0),
    };
    return formContext.registerField(fieldDef);
  }
});

async function startRecording() {
  if (!isSmrt || disabled || isParsing) return;

  parseError = null;
  recordingStartTime = Date.now();
  isRecording = true;

  // Guard STT init / mic acquisition so a rejection can't leave the field
  // wedged in a permanent "Recording..." state with no visible error (C2).
  try {
    if (!stt.isReady || stt.adapterType !== 'whisper-wasm') {
      await stt.initialize({ type: 'whisper-wasm' });
    }
    await stt.start({ continuous: true, interimResults: false });
  } catch (err) {
    isRecording = false;
    parseError =
      err instanceof Error ? err.message : 'Could not start voice input';
    logger.error('DateRangeInput: failed to start voice recording', {
      field: name,
      error: err,
    });
  }
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
    const parsed = await parseNaturalLanguageRange(finalTranscript);
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

// Keyboard activation for the mic (WCAG 2.1.1): Enter/Space toggles recording.
function handleMicKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

const primaryControlId = $derived(isSmrt ? `${name}_voice` : `${name}_start`);
</script>

<div
  class="smrt-date-range-input__root"
  class:smrt-date-range-input__listening={isRecording}
  class:smrt-date-range-input__parsing={isParsing}
  data-smrt-field-owner={fieldOwnerToken} data-smrt-component="DateRangeInput"
>
  {#if label}
    <FieldLabel for={primaryControlId} {label} {required} />
  {/if}

  <div class="smrt-date-range-input__range-wrapper" class:smrt-date-range-input__mode={isSmrt} class:smrt-date-range-input__invalid={showInvalid} data-smrt-part="field">
    {#if isSmrt}
      <!-- Voice mode: single input for the entire range -->
      <div class="smrt-date-range-input__voice-input-wrapper" data-smrt-part="field">
        <div class="smrt-date-range-input__voice-display" data-smrt-part="body">
          {#if startDisplay && endDisplay}
            <span class="smrt-date-range-input__date-value" data-smrt-part="value">{startDisplay}</span>
            <span class="smrt-date-range-input__range-separator" data-smrt-part="indicator">→</span>
            <span class="smrt-date-range-input__date-value" data-smrt-part="value">{endDisplay}</span>
          {:else if startDisplay}
            <span class="smrt-date-range-input__date-value" data-smrt-part="value">{startDisplay}</span>
            <span class="smrt-date-range-input__range-separator" data-smrt-part="indicator">→</span>
            <span class="smrt-date-range-input__placeholder" data-smrt-part="placeholder">{endPlaceholder}</span>
          {:else}
            <span class="smrt-date-range-input__placeholder" data-smrt-part="placeholder">Say "from [start] to [end]"</span>
          {/if}
        </div>

        <button
          bind:this={primaryControl}
          id={primaryControlId}
          type="button"
          class="smrt-date-range-input__mic-btn"
          class:smrt-date-range-input__active={isRecording}
          data-smrt-part="trigger"
          disabled={disabled || isParsing}
          onkeydown={handleMicKeydown}
          onmousedown={handleMouseDown}
          onmouseup={handleMouseUp}
          onmouseleave={handleMouseLeave}
          ontouchstart={handleTouchStart}
          ontouchend={handleTouchEnd}
          aria-label={t(M['ui.date_range_input.mic_aria_label'])}
        >
          {#if isParsing}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="smrt-date-range-input__spinner" data-smrt-part="spinner">
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
      <div class="smrt-date-range-input__date-inputs" data-smrt-part="row">
        <div class="smrt-date-range-input__date-field" data-smrt-part="field">
          <label for="{name}_start" class="smrt-date-range-input__field-label" data-smrt-part="label">Start</label>
          <input
            bind:this={primaryControl}
            id="{name}_start"
            name="{name}[startDate]"
            type="date"
            value={startDate}
            min={minDate}
            max={endDate || maxDate}
            {disabled}
            required={required}
            class="smrt-date-range-input__input"
            data-smrt-part="input"
            aria-invalid={showInvalid ? 'true' : undefined}
            aria-describedby={showInvalid ? `${name}-error` : undefined}
            onchange={handleStartChange}
          />
        </div>

        <span class="smrt-date-range-input__range-arrow" data-smrt-part="indicator">→</span>

        <div class="smrt-date-range-input__date-field" data-smrt-part="field">
          <label for="{name}_end" class="smrt-date-range-input__field-label" data-smrt-part="label">End</label>
          <input
            id="{name}_end"
            name="{name}[endDate]"
            type="date"
            value={endDate}
            min={startDate || minDate}
            max={maxDate}
            {disabled}
            required={required}
            class="smrt-date-range-input__input"
            data-smrt-part="input"
            aria-invalid={showInvalid ? 'true' : undefined}
            aria-describedby={showInvalid ? `${name}-error` : undefined}
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
    <div class="smrt-date-range-input__listening-indicator" data-smrt-part="status">Recording... say "from [start] to [end]"</div>
  {:else if isParsing}
    <div class="smrt-date-range-input__parsing-indicator" data-smrt-part="status">{t(M['ui.date_range_input.parsing'])}</div>
  {:else if parseError}
    <div id={`${name}-error`} class="smrt-date-range-input__error-indicator" data-smrt-part="error" role="alert">{parseError}</div>
  {:else if error}
    <div id={`${name}-error`} class="smrt-date-range-input__error-indicator" data-smrt-part="error" role="alert">{error}</div>
  {:else if !isValidRange}
    <div id={`${name}-error`} class="smrt-date-range-input__error-indicator" data-smrt-part="error" role="alert">
      {t(M['ui.date_range_input.end_after_start'])}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-date-range-input__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
  }
  .smrt-date-range-input__range-wrapper {
    display: flex;
    flex-direction: column;
  }
  .smrt-date-range-input__voice-input-wrapper {
    display: flex;
    align-items: center;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    gap: var(--smrt-spacing-2);
  }
  .smrt-date-range-input__voice-display {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
  }
  .smrt-date-range-input__date-inputs {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-3);
  }
  .smrt-date-range-input__date-field {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
  }
  .smrt-date-range-input__range-arrow {
    padding-bottom: var(--smrt-spacing-2);
  }
  .smrt-date-range-input__input {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
  }
  .smrt-date-range-input__input:disabled {
    cursor: not-allowed;
  }
  .smrt-date-range-input__mic-btn {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
  }
  .smrt-date-range-input__mic-btn:disabled {
    cursor: not-allowed;
  }
  @media (max-width: 600px) {
    .smrt-date-range-input__date-inputs {
      flex-direction: column;
      gap: var(--smrt-spacing-2);
    }
    .smrt-date-range-input__range-arrow {
      display: none;
    }
  }
}

@layer smrt.theme {
  .smrt-date-range-input__range-wrapper.smrt-date-range-input__mode {
    border: 1px solid var(--smrt-color-tertiary);
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-color-tertiary-container);
  }
  .smrt-date-range-input__range-wrapper.smrt-date-range-input__invalid {
    border-color: var(--smrt-color-error);
  }
  .smrt-date-range-input__voice-display {
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }
  .smrt-date-range-input__date-value {
    color: var(--smrt-color-on-surface);
  }
  .smrt-date-range-input__range-separator {
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-date-range-input__placeholder {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  .smrt-date-range-input__field-label {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    font-weight: var(--smrt-typography-body-small-weight, 500);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }
  .smrt-date-range-input__range-arrow {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-title-medium-size, 1.25rem);
  }
  .smrt-date-range-input__input {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-color-surface);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-date-range-input__input:focus {
    outline: none;
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary) 10%, transparent);
  }
  .smrt-date-range-input__input:disabled {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-date-range-input__mic-btn {
    background: transparent;
    border: none;
    border-radius: var(--smrt-radius-sm);
    color: var(--smrt-color-on-surface-variant);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-date-range-input__mic-btn:hover {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
  }
  .smrt-date-range-input__mic-btn.smrt-date-range-input__active {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary, white);
  }
  .smrt-date-range-input__mic-btn:disabled {
    opacity: 0.5;
  }
  .smrt-date-range-input__spinner {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-date-range-input__spinner {
      animation: none;
    }
  }
  .smrt-date-range-input__root.smrt-date-range-input__listening .smrt-date-range-input__range-wrapper.smrt-date-range-input__mode {
    border-color: var(--smrt-color-success);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-success) 30%, transparent);
    animation: pulse-green 1.5s var(--smrt-easing-standard, ease-in-out) infinite;
  }
  .smrt-date-range-input__root.smrt-date-range-input__parsing .smrt-date-range-input__range-wrapper.smrt-date-range-input__mode {
    border-color: var(--smrt-color-warning);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-warning) 20%, transparent);
  }
  @keyframes pulse-green {
    0%, 100% {
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-success) 30%, transparent);
    }
    50% {
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--smrt-color-success) 15%, transparent);
    }
  }
  .smrt-date-range-input__listening-indicator {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-primary);
  }
  .smrt-date-range-input__parsing-indicator {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-secondary);
  }
  .smrt-date-range-input__error-indicator {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-error);
  }
}

</style>
