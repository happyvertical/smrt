<script lang="ts">
import {
  type ControlInteractionEvent,
  type ControlInteractionRegistry,
  type ControlKind,
  createControlInteractionRegistry,
  setControlInteractionContext,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import { onDestroy } from 'svelte';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import { useSTT } from '../../hooks/useSTT.svelte.js';
import { M } from '../../i18n/strings.forms.js';
import { logger } from '../../internal/logger.js';
import {
  type FieldDefinition,
  type SMRTFormContext,
  setFormContext,
} from '../../state/form-context.js';
import { useWebMcpTool } from '../../web/webmcp.svelte.js';
import { tryGetWebMcpUiContext } from '../../web/webmcp-ui-context.js';
import type { LLMModelId, STTAdapterType } from './types.js';

const { t } = useI18n();

export interface Props {
  /** Form children */
  children: Snippet;
  /** Show mode toggle button */
  showModeToggle?: boolean;
  /** Show form-level listen button */
  showFormListen?: boolean;
  /** Silence timeout in seconds before stopping */
  silenceTimeout?: number;
  /** STT adapter type */
  sttAdapter?: STTAdapterType;
  /** LLM model for extraction (or 'none' for regex-only) */
  llmModel?: LLMModelId;
  /** Called when form is submitted (if provided, prevents native submission) */
  onsubmit?: (data: Record<string, unknown>) => void | Promise<void>;
  /** Expose this form's submit intent to WebMCP. */
  webmcp?: boolean | { name?: string; description?: string };
  /** Collection/model identity used when naming the generated intent. */
  collection?: string;
  /** HTTP method for native form submission (default: GET) */
  method?: 'GET' | 'POST';
  /** Form action URL for native form submission */
  action?: string;
  /** Stable identity used by control/agent interaction adapters. */
  formId?: string;
  interactionRegistry?: ControlInteractionRegistry;
  oninteraction?: (event: ControlInteractionEvent) => void;
  id?: string;
  name?: string;
  class?: string;
}

const {
  children,
  showModeToggle = false,
  showFormListen = false,
  silenceTimeout = 5,
  sttAdapter = 'whisper-wasm',
  llmModel = 'none',
  onsubmit,
  webmcp,
  collection,
  method,
  action,
  formId,
  interactionRegistry,
  oninteraction,
  id,
  name,
  class: className = '',
}: Props = $props();

const app = useAppState();
const stt = useSTT();
const instanceId = $props.id();
const generatedFormId = `smrt-form-${instanceId}`;
const localInteractionRegistry = createControlInteractionRegistry();
const providerWebMcpUi = tryGetWebMcpUiContext();
const resolvedFormId = $derived(formId ?? id ?? name ?? generatedFormId);
const resolvedInteractionRegistry = $derived(
  interactionRegistry ??
    (providerWebMcpUi?.enabled
      ? providerWebMcpUi.controlRegistry
      : undefined) ??
    localInteractionRegistry,
);
const interactionDisposers = new Map<string, () => void>();

setControlInteractionContext({
  get formId() {
    return resolvedFormId;
  },
  get registry() {
    return resolvedInteractionRegistry;
  },
});

$effect(() => {
  if (!oninteraction) return;
  return resolvedInteractionRegistry.subscribe((event) => {
    if (event.identity.formId === resolvedFormId) oninteraction(event);
  });
});

// Internal state
let fields = $state<Map<string, FieldDefinition>>(new Map());
let isFormListening = $state(false);
let isExtracting = $state(false);
let spokenText = $state('');
let extractError = $state<string | null>(null);
let lastSpeechTime = $state(0);
let silenceTimer: ReturnType<typeof setTimeout> | null = null;
let audioLevelInterval: ReturnType<typeof setInterval> | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let levelMonitorStream: MediaStream | null = null;

const isSmrt = $derived(app.state.mode === 'smrt');

function interactionKind(field: FieldDefinition): ControlKind {
  if (field.interactionKind) return field.interactionKind;
  switch (field.type) {
    case 'text':
    case 'email':
    case 'number':
    case 'checkbox':
    case 'select':
    case 'textarea':
      return field.type;
    case 'datetime':
      return 'datetime';
    default:
      return 'custom';
  }
}

// Create form context
const formContext: SMRTFormContext = {
  get mode() {
    return app.state.mode === 'smrt' ? 'smrt' : 'default';
  },
  registerField(field: FieldDefinition) {
    interactionDisposers.get(field.name)?.();
    fields.set(field.name, field);
    fields = new Map(fields); // Trigger reactivity
    interactionDisposers.set(
      field.name,
      resolvedInteractionRegistry.register({
        identity: {
          formId: resolvedFormId,
          controlId: field.controlId ?? field.name,
        },
        metadata: {
          kind: interactionKind(field),
          label: field.label,
          description: field.description,
          sensitivity: field.sensitivity ?? 'public',
          readable: field.readable,
          writable: field.writable,
          constraints: field.constraints,
          options: field.options,
          unit: field.unit,
        },
        getValue: field.getValue,
        setValue: field.setValue,
        clear: field.clear ?? (() => field.setValue('')),
        focus: field.focus,
        reveal: field.reveal,
        highlight: field.highlight,
        validate: field.validate,
        getState: field.getState,
      }),
    );
  },
  unregisterField(name: string) {
    interactionDisposers.get(name)?.();
    interactionDisposers.delete(name);
    fields.delete(name);
    fields = new Map(fields);
  },
  getFieldSchema() {
    return Array.from(fields.values());
  },
  get isFormListening() {
    return isFormListening;
  },
  get isExtracting() {
    return isExtracting;
  },
  toggleListening: () => toggleFormListening(),
  get interactionRegistry() {
    return resolvedInteractionRegistry;
  },
  get formId() {
    return resolvedFormId;
  },
};

function webMcpFieldSchema(field: FieldDefinition): Record<string, unknown> {
  let schema: Record<string, unknown>;
  if (field.webMcpSchema) {
    schema = { ...field.webMcpSchema };
  } else {
    switch (field.type) {
      case 'measurement':
        schema = {
          type: 'object',
          properties: {
            value: {
              type: 'number',
              ...(field.constraints?.min !== undefined
                ? { minimum: Number(field.constraints.min) }
                : {}),
              ...(field.constraints?.max !== undefined
                ? { maximum: Number(field.constraints.max) }
                : {}),
            },
            unit: {
              type: 'string',
              enum: ['ft', 'in', 'm', 'cm', 'mm', 'yd'],
            },
          },
          ...(field.constraints?.required
            ? { required: ['value', 'unit'] }
            : {}),
        };
        break;
      case 'daterange':
        schema = {
          type: 'object',
          properties: {
            startDate: { type: 'string' },
            endDate: { type: 'string' },
          },
          ...(field.constraints?.required
            ? { required: ['startDate', 'endDate'] }
            : {}),
        };
        break;
      case 'address':
        schema = {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
            province: { type: 'string' },
            postalCode: { type: 'string' },
            country: { type: 'string' },
          },
          ...(field.constraints?.required
            ? {
                required: [
                  'street',
                  'city',
                  'province',
                  'postalCode',
                  'country',
                ],
              }
            : {}),
        };
        break;
      case 'number':
      case 'money':
        schema = { type: 'number' };
        break;
      case 'checkbox':
        schema = { type: 'boolean' };
        break;
      default:
        schema = { type: 'string' };
    }
  }

  if (field.label) schema.title = field.label;
  if (field.description) schema.description = field.description;
  if (field.options) {
    schema.enum = field.options.map((option) => option.value);
  }
  if (schema.type === 'number' && field.constraints?.min !== undefined) {
    schema.minimum = Number(field.constraints.min);
  }
  if (schema.type === 'number' && field.constraints?.max !== undefined) {
    schema.maximum = Number(field.constraints.max);
  }
  if (schema.type === 'string' && field.constraints?.minLength !== undefined) {
    schema.minLength = field.constraints.minLength;
  }
  if (schema.type === 'string' && field.constraints?.maxLength !== undefined) {
    schema.maxLength = field.constraints.maxLength;
  }
  if (schema.type === 'string' && field.constraints?.pattern) {
    schema.pattern = field.constraints.pattern;
  }
  return schema;
}

function formInputSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of fields.values()) {
    properties[field.name] = webMcpFieldSchema(field);
    if (field.constraints?.required) required.push(field.name);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

// Provide context to children
setFormContext(formContext);

async function submitForWebMcp(args: Record<string, unknown>): Promise<string> {
  // Stage tool arguments through the same field setters used by native input
  // controls, then run the shared validation and submit path.
  for (const [name, value] of Object.entries(args)) {
    fields.get(name)?.setValue(value);
  }

  const data: Record<string, unknown> = {};
  let valid = true;
  for (const [name, field] of fields) {
    data[name] = field.getValue();
    if (
      field.constraints?.required &&
      (data[name] === '' || data[name] == null)
    ) {
      valid = false;
    }
    if (field.validate) {
      try {
        valid = field.validate() && valid;
      } catch {
        valid = false;
      }
    }
  }
  if (!valid) return 'Validation failed';
  if (!onsubmit) return 'No submit handler configured';

  await onsubmit(data);
  return 'Submitted successfully';
}

useWebMcpTool(() => {
  if (!webmcp) return null;
  const options = typeof webmcp === 'object' ? webmcp : {};
  return {
    name: options.name ?? `${collection ?? resolvedFormId}_submit`,
    description:
      options.description ??
      `Submit the ${collection ?? name ?? resolvedFormId} form after validating its fields`,
    inputSchema: formInputSchema(),
    annotations: { readOnlyHint: false },
    execute: submitForWebMcp,
  };
});

// Clean up extracted values based on field type
function cleanValue(value: unknown, fieldType: string): unknown {
  if (typeof value !== 'string') return value;

  let cleaned = value.trim();

  switch (fieldType) {
    case 'text':
      // Remove trailing periods from names
      cleaned = cleaned.replace(/\.$/, '');
      // Remove common speech artifacts
      cleaned = cleaned.replace(/^(my |the |it's |is )/i, '');
      break;
    case 'email':
      // Ensure email is properly formatted
      cleaned = cleaned
        .toLowerCase()
        .replace(/\s+at\s+/gi, '@')
        .replace(/\bat\b/gi, '@')
        .replace(/\s+dot\s+/gi, '.')
        .replace(/\bdot\b/gi, '.')
        .replace(/\s+/g, '');
      break;
  }

  return cleaned;
}

// Regex-based extraction from spoken text
function extractFieldsFromText(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const fieldDefs = Array.from(fields.values());

  // Normalize text: remove commas, extra spaces
  const normalized = text.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

  // Build list of all field triggers for boundary detection
  const allTriggers: string[] = [];
  for (const f of fieldDefs) {
    allTriggers.push(f.name.toLowerCase());
    if (f.label) {
      allTriggers.push(f.label.toLowerCase().replace(/\s+/g, '\\s+'));
    }
  }

  for (const field of fieldDefs) {
    const name = field.name.toLowerCase();
    const label = field.label?.toLowerCase() || '';

    // Build trigger patterns for this field
    // For "email" field with label "Email Address", match both:
    // - "email ..."
    // - "email address ..."
    const triggers: string[] = [];

    // Add label first (more specific, e.g., "email address")
    if (label) {
      triggers.push(label.replace(/\s+/g, '\\s+'));
    }
    // Add field name
    triggers.push(name);

    // Build boundary pattern (other field triggers)
    const otherTriggers = allTriggers.filter(
      (t) => t !== name && t !== label.replace(/\s+/g, '\\s+'),
    );
    const boundaryPattern =
      otherTriggers.length > 0
        ? `(?=\\s+(?:${otherTriggers.join('|')})|$)`
        : '$';

    for (const trigger of triggers) {
      // Match: trigger followed by optional "is", then capture value until boundary
      const pattern = new RegExp(
        `(?:^|\\s)${trigger}\\s+(?:is\\s+|and\\s+)?(.+?)${boundaryPattern}`,
        'i',
      );
      const match = normalized.match(pattern);

      if (match?.[1]) {
        let value = match[1].trim();

        // Remove trailing punctuation
        value = value.replace(/[.,!?]+$/, '').trim();

        // Clean up based on field type
        if (field.type === 'email') {
          value = value
            .toLowerCase()
            .replace(/\s+at\s+/gi, '@')
            .replace(/\bat\b/gi, '@')
            .replace(/\s+dot\s+/gi, '.')
            .replace(/\bdot\b/gi, '.')
            .replace(/\s+/g, '');
        }

        if (value) {
          result[field.name] = value;
          break; // Found value for this field, move to next
        }
      }
    }
  }

  return result;
}

// Extract fields from spoken text
// Currently uses regex-only since small local LLMs produce unreliable output
async function extractFields(text: string): Promise<Record<string, unknown>> {
  // Use regex extraction directly - fast and reliable
  // TODO: Add LLM enhancement when larger models are available
  const result = extractFieldsFromText(text);
  return result;
}

// Apply extracted values to fields with cleanup
function applyExtractedValues(values: Record<string, unknown>) {
  for (const [name, value] of Object.entries(values)) {
    const field = fields.get(name);
    if (field && value !== undefined && value !== null) {
      const cleanedValue = cleanValue(value, field.type);
      field.setValue(cleanedValue);
    }
  }
}

// Reset silence timer
function resetSilenceTimer() {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
  }
  lastSpeechTime = Date.now();
  silenceTimer = setTimeout(() => {
    if (isFormListening) {
      stopFormListening();
    }
  }, silenceTimeout * 1000);
}

// Start monitoring audio levels to detect speech (for Whisper which has no interim results)
async function startAudioLevelMonitoring(stream: MediaStream) {
  try {
    levelMonitorStream = stream;
    audioContext = new AudioContext();

    // Ensure AudioContext is running (may be suspended until user interaction)
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.3;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const SPEECH_THRESHOLD = 20; // Lowered from 30 for better sensitivity

    audioLevelInterval = setInterval(() => {
      if (!analyser || !isFormListening) return;

      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

      if (average > SPEECH_THRESHOLD) {
        // Speech detected - reset silence timer
        resetSilenceTimer();
      }
    }, 200); // Check every 200ms
  } catch (err) {
    // Audio-level monitoring is a silence-detection enhancement, not the
    // recording path itself — surface the failure but don't abort listening.
    // A getUserMedia/AudioContext denial here usually means mic-permission
    // issues the user needs to see (C3).
    extractError =
      err instanceof Error
        ? `Microphone monitoring unavailable: ${err.message}`
        : 'Microphone monitoring unavailable';
    logger.warn('Form: audio-level monitoring failed to start', { error: err });
  }
}

// Stop audio level monitoring
function stopAudioLevelMonitoring() {
  if (audioLevelInterval) {
    clearInterval(audioLevelInterval);
    audioLevelInterval = null;
  }
  if (levelMonitorStream) {
    for (const track of levelMonitorStream.getTracks()) {
      track.stop();
    }
    levelMonitorStream = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
  }
}

// Check for "done" keyword
function checkForDoneKeyword(text: string): boolean {
  const lowerText = text.toLowerCase();
  // Check if the last word is "done" or ends with "done"
  return lowerText.endsWith('done') || lowerText.endsWith('done.');
}

// Guard to prevent multiple simultaneous stop calls
let isStopping = false;
// Guard to prevent premature stop during startup
let isStarting = false;
// Timestamp of last stop to prevent immediate restart
let lastStopTime = 0;
const RESTART_COOLDOWN_MS = 1000; // 1 second cooldown after stopping
// Track the last processed STT result to avoid re-processing stale results
let lastProcessedResult = '';

// Watch STT results while form is listening
// Only track speech and check for "done" - extraction happens at the end
$effect(() => {
  if (isFormListening && stt.lastResult && !isStopping) {
    const newText = stt.lastResult;

    // Skip if this is the same result we already processed (stale from previous session)
    if (newText === lastProcessedResult) {
      return;
    }
    lastProcessedResult = newText;
    spokenText = newText;

    // Reset silence timer on new speech (for browser STT with interim results)
    if (sttAdapter === 'browser-speech') {
      resetSilenceTimer();
    }

    // Check for "done" keyword
    if (checkForDoneKeyword(newText)) {
      // Don't set isStopping here - let stopFormListening() do it after passing the guard
      stopFormListening();
    }
  }
});

// Watch for STT stopping unexpectedly (e.g., browser STT auto-stops after silence)
$effect(() => {
  // If form thinks we're listening but STT has stopped, handle it
  // Don't trigger during startup phase (isStarting) or shutdown phase (isStopping)
  if (isFormListening && !stt.isListening && !isStopping && !isStarting) {
    // Use setTimeout to avoid state update during render
    setTimeout(() => {
      if (isFormListening && !isStopping && !isStarting) {
        stopFormListening();
      }
    }, 0);
  }
});

async function toggleFormListening() {
  if (isFormListening) {
    await stopFormListening();
  } else {
    // Prevent immediate restart after stopping (UI might lag behind state)
    const timeSinceStop = Date.now() - lastStopTime;
    if (lastStopTime > 0 && timeSinceStop < RESTART_COOLDOWN_MS) {
      return;
    }
    await startFormListening();
  }
}

async function startFormListening() {
  if (!isSmrt) return;

  // Set starting flag to prevent premature stop detection
  isStarting = true;

  // STT init / start can reject (model fetch failure, mic-permission denial).
  // Without this guard `isStarting`/`isFormListening` would stay set, the
  // auto-stop $effect (gated on `!isStarting`) would stay suppressed, and the
  // form would wedge in a permanent "listening" state with no surfaced error
  // (C2). On failure: tear down, reset flags, and show the error.
  try {
    // Initialize STT with selected adapter
    if (!stt.isReady || stt.adapterType !== sttAdapter) {
      await stt.initialize({ type: sttAdapter });
    }

    extractError = null;
    spokenText = '';
    // Set to current stale result so the effect skips it, but new results will be processed
    lastProcessedResult = stt.lastResult || '';
    isFormListening = true;
    isStopping = false;
    lastSpeechTime = Date.now();

    // Start silence timer
    resetSilenceTimer();

    // Start audio level monitoring for Whisper (no interim results)
    // Browser STT has interim results so doesn't need this
    if (sttAdapter === 'whisper-wasm') {
      try {
        const levelStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        startAudioLevelMonitoring(levelStream);
      } catch (err) {
        // Mic-permission denial / no device — surface it; the user must see
        // why dictation isn't working (C3).
        extractError =
          err instanceof Error
            ? `Microphone access failed: ${err.message}`
            : 'Microphone access failed';
        logger.warn('Form: getUserMedia failed for audio-level monitoring', {
          error: err,
        });
      }
    }

    await stt.start({ continuous: true, interimResults: true });
  } catch (err) {
    // Reset listening state so the form isn't wedged, and stop any monitoring
    // that may have started before the failure.
    isFormListening = false;
    stopAudioLevelMonitoring();
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    extractError =
      err instanceof Error
        ? err.message
        : 'Could not start voice input. Check microphone permissions.';
    logger.error('Form: failed to start form listening', { error: err });
  } finally {
    // Clear starting flag now that STT is actually listening (or has failed).
    isStarting = false;
  }
}

async function stopFormListening() {
  if (!isFormListening || isStopping) {
    return;
  }
  isStopping = true;
  isStarting = false; // Ensure starting flag is cleared

  // Clear silence timer
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  // Stop audio level monitoring
  stopAudioLevelMonitoring();

  // IMPORTANT: Keep isFormListening = true until after stt.stop() completes
  // This allows the $effect to capture any final results
  await stt.stop();

  // Now capture the final result AFTER stop completes
  // stt.stop() waits for transcription to finish in whisper-wasm
  const finalResult = stt.lastResult || '';

  // NOW we can set isFormListening to false
  isFormListening = false;

  // Final extraction on the captured result
  const textToExtract = (finalResult || spokenText || '')
    .replace(/\s*done\.?$/i, '')
    .trim();

  if (textToExtract) {
    isExtracting = true;
    extractError = null;

    try {
      const values = await extractFields(textToExtract);
      applyExtractedValues(values);
    } catch (err) {
      extractError =
        err instanceof Error ? err.message : 'Failed to extract fields';
    } finally {
      isExtracting = false;
      isStopping = false;
    }
  } else {
    isStopping = false;
  }

  // Record stop time to prevent immediate restart
  lastStopTime = Date.now();
}

// Cleanup on destroy
onDestroy(() => {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
  }
  stopAudioLevelMonitoring();
  for (const dispose of interactionDisposers.values()) dispose();
  interactionDisposers.clear();
});

function handleModeToggle() {
  const newMode = app.state.mode === 'smrt' ? 'default' : 'smrt';
  app.setMode(newMode);
}

function handleSubmit(e: Event) {
  // Only prevent default if we have an onsubmit handler
  // This allows native form submission for SvelteKit form actions
  if (onsubmit) {
    e.preventDefault();
    void submitForWebMcp({}).catch((error) => {
      logger.error('Form submit failed', { error });
    });
  }
  // Otherwise, let native form submission happen (e.g., for SvelteKit use:enhance)
}

export function getFormData(): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [name, field] of fields) {
    data[name] = field.getValue();
  }
  return data;
}

export function getInteractionRegistry(): ControlInteractionRegistry {
  return resolvedInteractionRegistry;
}
</script>

<form
  {id}
  {name}
  class="smrt-form {className}"
  data-smrt-form={resolvedFormId}
  onsubmit={handleSubmit}
  {method}
  {action}
>
  <!--
    Screen-reader status region (L1 #1420): announces async STT / field-
    extraction state politely, since the visible cues live on a button whose
    label change isn't reliably announced. Visually hidden — the button still
    shows the same state to sighted users.
  -->
  <div class="smrt-form__status" role="status" aria-live="polite">
    {#if isExtracting}
      {t(M['ui.form.extracting'])}
    {:else if isFormListening}
      {t(M['ui.form.listening_status'])}
    {/if}
  </div>

  {#if showModeToggle || showFormListen}
    <div class="form-controls">
      {#if showModeToggle}
        <div class="mode-toggle">
          <button
            type="button"
            class="mode-btn"
            class:active={!isSmrt}
            onclick={handleModeToggle}
          >
            Dumb
          </button>
          <button
            type="button"
            class="mode-btn"
            class:active={isSmrt}
            onclick={handleModeToggle}
          >
            s-m-r-t
          </button>
        </div>
      {/if}

      {#if showFormListen && isSmrt}
        <button
          type="button"
          class="form-listen-btn"
          class:listening={isFormListening}
          class:extracting={isExtracting}
          onclick={toggleFormListening}
        >
          {#if isExtracting}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="spinner"
            >
              <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/>
            </svg>
            Extracting...
          {:else if isFormListening}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="6" y="4" width="4" height="16"/>
              <rect x="14" y="4" width="4" height="16"/>
            </svg>
            {t(M['ui.form.listening_button'])}
          {:else}
            <svg
              width="18"
              height="18"
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
            {t(M['ui.form.speak_all_fields'])}
          {/if}
        </button>
      {/if}
    </div>
  {/if}

  {#if extractError}
    <div class="extract-error" role="alert">{extractError}</div>
  {/if}

  <div class="form-fields">
    {@render children()}
  </div>
</form>

{#if isFormListening && spokenText}
  <div class="spoken-toaster">
    <strong>{t(M['ui.form.you_said'])}</strong> {spokenText}
  </div>
{/if}

<style>
  .smrt-form {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 16px);
  }

  /* Visually-hidden live region (L1 #1420) — announced to screen readers only. */
  .smrt-form__status {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .form-controls {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-4, 16px);
    flex-wrap: wrap;
  }

  .mode-toggle {
    display: flex;
    background: var(--smrt-color-surface-container-high, #f3f4f6);
    padding: var(--smrt-spacing-1, 4px);
    border-radius: var(--smrt-radius-md, 8px);
  }

  .mode-btn {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-4, 16px);
    border: none;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    border-radius: var(--smrt-radius-md, 8px);
    cursor: pointer;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .mode-btn:hover {
    color: var(--smrt-color-on-surface, #374151);
  }

  .mode-btn.active {
    background: var(--smrt-color-surface, #fff);
    color: var(--smrt-color-primary, #3b82f6);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px color-mix(in srgb, var(--smrt-color-shadow) 10%, transparent));
  }

  .form-listen-btn {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-3, 12px) var(--smrt-spacing-5, 20px);
    border: 2px solid var(--smrt-color-primary, #3b82f6);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-primary);
    border-radius: var(--smrt-radius-md, 8px);
    cursor: pointer;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .form-listen-btn:hover {
    background: var(--smrt-color-primary-container, #eff6ff);
  }

  .form-listen-btn.listening {
    background: var(--smrt-color-primary, #22c55e);
    border-color: var(--smrt-color-primary, #22c55e);
    color: var(--smrt-color-on-primary, #fff);
    animation: pulse-btn 1.5s var(--smrt-easing-standard, ease-in-out) infinite;
  }

  .form-listen-btn.extracting {
    background: var(--smrt-color-secondary, #f59e0b);
    border-color: var(--smrt-color-secondary, #f59e0b);
    color: var(--smrt-color-on-secondary, #fff);
  }

  .form-listen-btn:disabled {
    cursor: not-allowed;
  }

  @keyframes pulse-btn {
    0%, 100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--smrt-color-success) 40%, transparent);
    }
    50% {
      box-shadow: 0 0 0 8px transparent;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .form-listen-btn.listening {
      animation: none;
    }
  }

  .spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .spoken-toaster {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    padding: var(--smrt-spacing-3, 12px) var(--smrt-spacing-6, 24px);
    /* 90%-opacity primary. The old `--smrt-color-primary-rgb` channel token
       was never emitted (issue #1431); color-mix derives the alpha from the
       emitted `--smrt-color-primary` token instead. */
    background: color-mix(in srgb, var(--smrt-color-primary, #166534) 90%, transparent);
    color: var(--smrt-color-on-primary, #fff);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    box-shadow: 0 -2px 12px color-mix(in srgb, var(--smrt-color-shadow) 15%, transparent);
    z-index: var(--smrt-z-index-toast, 1500);
    text-align: center;
    backdrop-filter: blur(8px);
    animation: slideUp 0.2s ease-out;
  }

  .spoken-toaster strong {
    color: var(--smrt-color-on-primary-container, #bbf7d0);
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(100%);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .extract-error {
    padding: var(--smrt-spacing-3, 12px) var(--smrt-spacing-4, 16px);
    background: var(--smrt-color-error-container);
    border: 1px solid var(--smrt-color-error);
    border-radius: var(--smrt-radius-md, 8px);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-error);
  }

  .form-fields {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 16px);
  }
</style>
