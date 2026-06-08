<script lang="ts">
import type { Snippet } from 'svelte';
import { onDestroy } from 'svelte';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import { useSTT } from '../../hooks/useSTT.svelte.js';
import {
  type FieldDefinition,
  type SMRTFormContext,
  setFormContext,
} from '../../state/form-context.js';
import type { LLMModelId, STTAdapterType } from './types.js';

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
  onsubmit?: (data: Record<string, unknown>) => void;
  /** HTTP method for native form submission (default: GET) */
  method?: 'GET' | 'POST';
  /** Form action URL for native form submission */
  action?: string;
}

const {
  children,
  showModeToggle = false,
  showFormListen = false,
  silenceTimeout = 5,
  sttAdapter = 'whisper-wasm',
  llmModel = 'none',
  onsubmit,
  method,
  action,
}: Props = $props();

const app = useAppState();
const stt = useSTT();

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

// Create form context
const formContext: SMRTFormContext = {
  get mode() {
    return app.state.mode === 'smrt' ? 'smrt' : 'default';
  },
  registerField(field: FieldDefinition) {
    fields.set(field.name, field);
    fields = new Map(fields); // Trigger reactivity
  },
  unregisterField(name: string) {
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
};

// Provide context to children
setFormContext(formContext);

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

  console.log('[SMRTForm] Normalized text:', normalized);

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
          console.log(`[SMRTForm] Regex extracted ${field.name}:`, value);
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
  console.log('[SMRTForm] Extracting fields from:', text);

  // Use regex extraction directly - fast and reliable
  // TODO: Add LLM enhancement when larger models are available
  const result = extractFieldsFromText(text);

  console.log('[SMRTForm] Extracted:', result);
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
      console.log('[SMRTForm] Silence timeout - stopping');
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
    let checksWithSpeech = 0;

    console.log(
      '[SMRTForm] Audio level monitoring started, AudioContext state:',
      audioContext.state,
    );

    audioLevelInterval = setInterval(() => {
      if (!analyser || !isFormListening) return;

      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

      // Log periodically to debug
      checksWithSpeech++;
      if (checksWithSpeech % 10 === 0) {
        console.log('[SMRTForm] Audio level avg:', average.toFixed(1));
      }

      if (average > SPEECH_THRESHOLD) {
        // Speech detected - reset silence timer
        resetSilenceTimer();
      }
    }, 200); // Check every 200ms
  } catch (err) {
    console.warn('[SMRTForm] Could not set up audio level monitoring:', err);
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
      console.log('[SMRTForm] "Done" keyword detected - stopping');
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
    console.log('[SMRTForm] STT stopped unexpectedly - handling end of speech');
    // Use setTimeout to avoid state update during render
    setTimeout(() => {
      if (isFormListening && !isStopping && !isStarting) {
        stopFormListening();
      }
    }, 0);
  }
});

async function toggleFormListening() {
  console.log(
    '[SMRTForm] toggleFormListening called, isFormListening:',
    isFormListening,
  );

  if (isFormListening) {
    await stopFormListening();
  } else {
    // Prevent immediate restart after stopping (UI might lag behind state)
    const timeSinceStop = Date.now() - lastStopTime;
    if (lastStopTime > 0 && timeSinceStop < RESTART_COOLDOWN_MS) {
      console.log(
        '[SMRTForm] Ignoring start - cooldown active, time since stop:',
        timeSinceStop,
      );
      return;
    }
    await startFormListening();
  }
}

async function startFormListening() {
  if (!isSmrt) return;

  // Set starting flag to prevent premature stop detection
  isStarting = true;

  // Initialize STT with selected adapter
  if (!stt.isReady || stt.adapterType !== sttAdapter) {
    console.log(`[SMRTForm] Initializing STT adapter: ${sttAdapter}`);
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
      console.warn('[SMRTForm] Could not get mic for level monitoring:', err);
    }
  }

  await stt.start({ continuous: true, interimResults: true });

  // Clear starting flag now that STT is actually listening
  isStarting = false;
}

async function stopFormListening() {
  console.log(
    '[SMRTForm] stopFormListening called, isFormListening:',
    isFormListening,
    'isStopping:',
    isStopping,
  );
  if (!isFormListening || isStopping) {
    console.log('[SMRTForm] stopFormListening returning early');
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
  console.log('[SMRTForm] Audio monitoring stopped, calling stt.stop()');

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
  console.log('[SMRTForm] Final text to extract:', textToExtract);

  if (textToExtract) {
    isExtracting = true;
    extractError = null;

    try {
      console.log('[SMRTForm] Running final extraction...');
      const values = await extractFields(textToExtract);
      console.log('[SMRTForm] Extracted values:', values);
      applyExtractedValues(values);
    } catch (err) {
      console.error('[SMRTForm] Extraction error:', err);
      extractError =
        err instanceof Error ? err.message : 'Failed to extract fields';
    } finally {
      isExtracting = false;
      isStopping = false;
    }
  } else {
    console.log('[SMRTForm] No text to extract');
    isStopping = false;
  }

  // Record stop time to prevent immediate restart
  lastStopTime = Date.now();
  console.log('[SMRTForm] Stop complete, cooldown started');
}

// Cleanup on destroy
onDestroy(() => {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
  }
  stopAudioLevelMonitoring();
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
    const data: Record<string, unknown> = {};
    for (const [name, field] of fields) {
      data[name] = field.getValue();
    }
    onsubmit(data);
  }
  // Otherwise, let native form submission happen (e.g., for SvelteKit use:enhance)
}

function getFormData(): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [name, field] of fields) {
    data[name] = field.getValue();
  }
  return data;
}
</script>

<form class="smrt-form" onsubmit={handleSubmit} {method} {action}>
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
            Listening... (say "done" to finish)
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
            Speak all fields
          {/if}
        </button>
      {/if}
    </div>
  {/if}

  {#if extractError}
    <div class="extract-error">{extractError}</div>
  {/if}

  <div class="form-fields">
    {@render children()}
  </div>
</form>

{#if isFormListening && spokenText}
  <div class="spoken-toaster">
    <strong>You said:</strong> {spokenText}
  </div>
{/if}

<style>
  .smrt-form {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 16px);
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
    border-radius: 8px;
  }

  .mode-btn {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-4, 16px);
    border: none;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .mode-btn:hover {
    color: var(--smrt-color-on-surface, #374151);
  }

  .mode-btn.active {
    background: var(--smrt-color-surface, #fff);
    color: var(--smrt-color-primary, #3b82f6);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--smrt-color-shadow) 10%, transparent);
  }

  .form-listen-btn {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-3, 12px) var(--smrt-spacing-5, 20px);
    border: 2px solid var(--smrt-color-primary, #3b82f6);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-primary);
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
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
    color: white;
    font-size: 0.875rem;
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
    border-radius: 8px;
    font-size: 0.875rem;
    color: var(--smrt-color-error);
  }

  .form-fields {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 16px);
  }
</style>
