<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { ripple } from '../../actions/ripple.js';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import { useSTT } from '../../hooks/useSTT.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import { formatText } from '../../utils/forms/formatters.js';
import { Icon } from '../display/index.js';

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
let isFocused = $state(false);
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
    const formattedValue = formatText(finalTranscript);

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

<div 
  class="smrt-text-field multiline" 
  class:smrt-mode={isSmrt} 
  class:focused={isFocused} 
  class:disabled
  class:has-value={!!value}
  class:listening={isHolding}
>
  <div class="container">
    <div class="content">
      {#if label}
        <label for={name} class="label">{label}{#if required}*{/if}</label>
      {/if}
      <textarea
        bind:this={textareaEl}
        id={name}
        {name}
        placeholder={isFocused ? placeholder : ''}
        {value}
        {rows}
        disabled={disabled || isProcessing}
        {required}
        class="input"
        oninput={handleInput}
        onfocus={() => isFocused = true}
        onblur={() => isFocused = false}
        onmousedown={isSmrt ? handleMouseDown : undefined}
        onmouseup={isSmrt ? handleMouseUp : undefined}
        onmouseleave={isSmrt ? handleMouseLeave : undefined}
        ontouchstart={isSmrt ? handleTouchStart : undefined}
        ontouchend={isSmrt ? handleTouchEnd : undefined}
      ></textarea>
    </div>

    {#if isSmrt}
      <button
        type="button"
        class="mic-btn"
        class:active={isHolding}
        {disabled}
        use:ripple
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

  <div class="supporting-text">
    {#if isInitializing}
      <span class="info">Downloading Whisper model... {downloadProgress}%</span>
    {:else if isHolding}
      <span class="success">Recording...</span>
    {:else if isProcessing}
      <span class="info">Processing...</span>
    {:else if processError}
      <span class="error">{processError}</span>
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
  }

  .container {
    position: relative;
    display: flex;
    align-items: flex-start;
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
    padding-top: var(--smrt-spacing-2, 8px);
    padding-bottom: var(--smrt-spacing-2, 8px);
  }

  .label {
    font-size: 1rem;
    line-height: 1.5;
    letter-spacing: 0.5px;
    color: var(--field-color);
    pointer-events: none;
    transition: all var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
    transform-origin: top left;
    margin-bottom: var(--smrt-spacing-1, 4px);
  }

  .focused .label, .has-value .label, .listening .label {
    transform: translateY(-4px) scale(0.75);
    color: var(--field-active);
  }

  .input {
    border: none;
    background: transparent;
    font-size: 1rem;
    line-height: 1.5;
    letter-spacing: 0.5px;
    color: var(--smrt-color-on-surface);
    width: 100%;
    padding: 0;
    margin: 0;
    resize: vertical;
    font-family: inherit;
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
    margin-top: var(--smrt-spacing-2, 8px);
    transition: all 200ms;
  }

  .mic-btn.active {
    color: var(--smrt-color-primary);
    background-color: var(--smrt-color-primary-container);
  }

  .supporting-text {
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-4, 16px) 0;
    font-size: 0.75rem;
    min-height: 16px;
  }

  .info { color: var(--smrt-color-on-surface-variant); }
  .error { color: var(--smrt-color-error); }
  .success { color: var(--smrt-color-primary); }

  .listening {
    background-color: var(--smrt-color-primary-container);
  }

  .disabled {
    opacity: 0.38;
    pointer-events: none;
  }

  .smrt-mode {
    --field-active: var(--smrt-color-tertiary);
  }
</style>