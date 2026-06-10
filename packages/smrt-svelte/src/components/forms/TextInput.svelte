<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { ripple } from '../../actions/ripple.js';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import { useSTT } from '../../hooks/useSTT.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import { formatEmail, formatText } from '../../utils/forms/formatters.js';
import { Icon } from '../display/index.js';

export interface Props {
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
let isFocused = $state(false);
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
const supportingTextId = $derived(`${name}-supporting-text`);
const hasSupportingText = $derived(
  isInitializing ||
    isHolding ||
    isProcessing ||
    !!processError ||
    !!showInvalid ||
    !!(description && isFocused),
);
const ariaInvalid = $derived(showInvalid || processError ? 'true' : undefined);

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
    const validatedValue =
      type === 'email'
        ? formatEmail(finalTranscript)
        : formatText(finalTranscript);

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

function handleInput(e: Event) {
  const target = e.target as HTMLInputElement;
  updateValue(target.value);
}
</script>

<div 
  class="smrt-text-field" 
  class:smrt-mode={isSmrt} 
  class:focused={isFocused} 
  class:invalid={showInvalid}
  class:disabled
  class:has-value={!!value}
  class:listening={isHolding}
>
  <div class="container">
    <div class="content">
      {#if label}
        <label for={name} class="label">{label}{#if required}*{/if}</label>
      {/if}
      <input
        bind:this={inputEl}
        id={name}
        {name}
        type={type}
        placeholder={isFocused ? placeholder : ''}
        {value}
        disabled={disabled || isProcessing}
        {required}
        aria-describedby={hasSupportingText ? supportingTextId : undefined}
        aria-invalid={ariaInvalid}
        class="input"
        oninput={handleInput}
        onfocus={() => isFocused = true}
        onblur={() => isFocused = false}
        onmousedown={isSmrt ? handleMouseDown : undefined}
        onmouseup={isSmrt ? handleMouseUp : undefined}
        onmouseleave={isSmrt ? handleMouseLeave : undefined}
        ontouchstart={isSmrt ? handleTouchStart : undefined}
        ontouchend={isSmrt ? handleTouchEnd : undefined}
      />
    </div>

    {#if isSmrt}
      <button
        type="button"
        class="mic-btn"
        class:active={isHolding}
        {disabled}
        use:ripple
        onclick={handleMicClick}
        onmousedown={(e) => { e.stopPropagation(); if (e.button === 0) startHoldRecording(); }}
        onmouseup={handleMouseUp}
        onmouseleave={handleMouseLeave}
        ontouchstart={(e) => { e.stopPropagation(); e.preventDefault(); startHoldRecording(); }}
        ontouchend={handleTouchEnd}
        aria-label="Hold to speak"
      >
        <Icon name="mic" size={20} />
      </button>
    {/if}

    <div class="active-indicator"></div>
  </div>

  <div id={supportingTextId} class="supporting-text" aria-live="polite">
    {#if isInitializing}
      <span class="info">Downloading Whisper model... {downloadProgress}%</span>
    {:else if isHolding}
      <span class="success">Recording...</span>
    {:else if isProcessing}
      <span class="info">Processing...</span>
    {:else if processError}
      <span class="error">{processError}</span>
    {:else if showInvalid}
      <span class="error">Invalid email address</span>
    {:else if description && isFocused}
      <span class="info">{description}</span>
    {/if}
  </div>
</div>

<style>
  .smrt-text-field {
    --field-color: var(--smrt-color-on-surface-variant);
    --field-bg: var(--smrt-color-surface-container-highest);
    --field-active: var(--smrt-color-primary);
    
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 240px;
  }

  .container {
    position: relative;
    display: flex;
    align-items: center;
    background-color: var(--field-bg);
    border-radius: var(--smrt-radius-sm, 4px) var(--smrt-radius-sm, 4px) 0 0;
    min-height: 56px;
    padding: 0 var(--smrt-spacing-4, 16px);
    transition: background-color var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
  }

  .container:hover {
    background-color: var(--smrt-color-surface-container-high);
  }

  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    height: 100%;
    padding-top: var(--smrt-spacing-2, 8px);
  }

  .label {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    line-height: var(--smrt-typography-body-large-line-height, 1.5);
    letter-spacing: var(--smrt-typography-body-large-tracking, 0.5px);
    color: var(--field-color);
    pointer-events: none;
    transition: all var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
    transform-origin: top left;
  }

  /* Label float logic */
  .focused .label, .has-value .label, .listening .label {
    transform: translateY(-8px) scale(0.75);
    color: var(--field-active);
  }

  .input {
    border: none;
    background: transparent;
    font-size: var(--smrt-typography-body-large-size, 1rem);
    line-height: var(--smrt-typography-body-large-line-height, 1.5);
    letter-spacing: var(--smrt-typography-body-large-tracking, 0.5px);
    color: var(--smrt-color-on-surface);
    width: 100%;
    padding: 0;
    margin: 0;
    height: 24px;
  }

  .input:focus {
    outline: none;
  }

  .active-indicator {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 1px;
    background-color: var(--field-color);
    transition: all var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
  }

  .focused .active-indicator {
    height: 2px;
    background-color: var(--field-active);
  }

  .mic-btn {
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--field-color);
    border-radius: var(--smrt-radius-full, 9999px);
    cursor: pointer;
    margin-right: -8px;
    transition: all 200ms;
  }

  .mic-btn.active {
    color: var(--smrt-color-primary);
    background-color: var(--smrt-color-primary-container);
  }

  .supporting-text {
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-4, 16px) 0;
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    min-height: 16px;
  }

  .info { color: var(--smrt-color-on-surface-variant); }
  .error { color: var(--smrt-color-error); }
  .success { color: var(--smrt-color-primary); }

  /* States */
  .invalid {
    --field-active: var(--smrt-color-error);
    --field-color: var(--smrt-color-error);
  }

  .listening {
    background-color: var(--smrt-color-primary-container);
  }

  .disabled {
    opacity: 0.38;
    pointer-events: none;
  }
</style>