<!--
  Signature pad that draws on its own canvas and returns a PNG.

  A committed signature leaves through `onCapture({ blob, dataUrl })` and, when
  `name` is set, posts in a plain native form as a file field, the same way
  `CameraCapture` posts its photo (`native-file-field.ts`).

  `stylusOnly` is resolved by the caller (a tenant setting, a device profile)
  and passed in; the pointer-type gate is the pure `isAcceptedPointerType()` in
  `signature-pad-logic.ts`. "Use signature" stays disabled until an accepted
  stroke exists, so an empty canvas can never be submitted. Once committed the
  canvas is locked; "Clear" discards the signature and unlocks it. A reset of
  the owning form does the same, as it empties a native file input.

  The bitmap is painted white and inked dark in every theme and colour scheme:
  a signature is document content, so the exported PNG reads the same wherever
  it is shown, and the pad looks like paper in dark mode too.

  Ported from teamworks-os `SignaturePad.svelte`, smrt#3290.
-->
<script lang="ts">
import { onMount, untrack } from 'svelte';
import { M, useI18n } from '../../i18n/index.js';
import {
  focusControl,
  highlightControl,
  revealControl,
} from './control-dom.js';
import type { ControlInteractionOptions } from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import {
  assignFileWithDataTransfer,
  attachFormDataFallback,
  attachFormResetListener,
  clearFileInput,
  detectNativeFileFieldStrategy,
  type NativeFileFieldStrategy,
} from './native-file-field.js';
import {
  isAcceptedPointerType,
  mapPointerToCanvasPoint,
  SIGNATURE_INK_COLOR,
  SIGNATURE_PAPER_COLOR,
} from './signature-pad-logic.js';
import type {
  CaptureResult,
  SignaturePadLabels,
  SignaturePadState,
} from './types.js';
import { useControlRegistration } from './use-control-registration.svelte.js';

export interface Props {
  /** Accept pen input only; the caller resolves this rule. */
  stylusOnly?: boolean;
  /** Ignores input and disables both actions. */
  disabled?: boolean;
  /** Called when the user commits a signature with "Use signature". */
  onCapture?: (result: CaptureResult) => void;
  /** Called when a committed signature is discarded by "Clear" or a form reset. */
  onClear?: () => void;
  /** Field name: the committed PNG posts as a file in a native form. */
  name?: string;
  /** Posted file name. */
  fileName?: string;
  /** Canvas backing width in pixels (the display width is responsive). */
  width?: number;
  /** Canvas backing height in pixels. */
  height?: number;
  /** Text overrides; defaults come from the `ui` i18n catalog. */
  labels?: Partial<SignaturePadLabels>;
  /** DOM id of the component root. */
  id?: string;
  /** CSS class to apply to the component root. */
  class?: string;
  /** Interaction options or false to disable registration. */
  interaction?: ControlInteractionOptions | false;
}

let {
  stylusOnly = false,
  disabled = false,
  onCapture,
  onClear,
  name,
  fileName = 'signature.png',
  width = 600,
  height = 240,
  labels,
  id,
  class: className = '',
  interaction,
}: Props = $props();

const { t } = useI18n();
const text = $derived<SignaturePadLabels>({
  region: t(M['ui.signature_pad.region']),
  canvasEmpty: t(M['ui.signature_pad.canvas_empty']),
  canvasSigned: t(M['ui.signature_pad.canvas_signed']),
  hintAny: t(M['ui.signature_pad.hint_any']),
  hintStylus: t(M['ui.signature_pad.hint_stylus']),
  clear: t(M['ui.signature_pad.clear']),
  useSignature: t(M['ui.signature_pad.use_signature']),
  committed: t(M['ui.signature_pad.committed']),
  ...labels,
});

const instanceId = $props.id();
const interactionContext = tryGetControlInteractionContext();
const resolvedId = $derived(id ?? `smrt-signature-${instanceId}`);
const hintId = $derived(`${resolvedId}-hint`);
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name ?? resolvedId),
);

let padState = $state<SignaturePadState>('empty');
let strategy = $state<NativeFileFieldStrategy>('data-transfer');
let rootEl = $state<HTMLDivElement | null>(null);
let canvasEl = $state<HTMLCanvasElement | null>(null);
let fieldEl = $state<HTMLInputElement | null>(null);
let activePointerId: number | null = null;
let lastPoint: { x: number; y: number } | null = null;
let committedFile: File | null = null;
// Set while "Use signature" encodes the PNG: the pad is locked so the posted
// file always equals the ink on screen, and a second click cannot commit twice.
let encoding = $state(false);
let encodeRequest = 0;

function paintPaper(): void {
  const context = canvasEl?.getContext('2d');
  if (!context || !canvasEl) return;
  context.fillStyle = SIGNATURE_PAPER_COLOR;
  context.fillRect(0, 0, canvasEl.width, canvasEl.height);
}

onMount(() => {
  strategy = detectNativeFileFieldStrategy();
});

// Paint paper when the canvas mounts. A backing-size change clears the bitmap,
// so it resets the pad (discarding a committed signature) rather than leaving
// a posted file that no longer matches what is shown. Only a real change
// counts: a re-run at the same size (a parent re-spreading a fresh props
// object) leaves the bitmap intact and must not discard the signature.
let paintedFor: { canvas: HTMLCanvasElement; size: string } | null = null;
$effect(() => {
  const canvas = canvasEl;
  const size = `${width}x${height}`;
  if (!canvas || (paintedFor?.canvas === canvas && paintedFor.size === size)) {
    return;
  }
  paintedFor = { canvas, size };
  untrack(resetPad);
});

$effect(() => {
  if (strategy !== 'formdata-event' || typeof document === 'undefined') return;
  return attachFormDataFallback(document, () =>
    name && fieldEl
      ? { form: fieldEl.form, name, file: committedFile, source: fieldEl }
      : null,
  );
});

// A reset of the owning form (`form.reset()`, a reset button, `enhance`'s
// `update()` after a success) empties a native file input, so it discards the
// signature exactly as "Clear" does: committed or still being drawn, and even
// while `disabled`, as a reset empties a disabled native input too.
$effect(() => {
  if (typeof document === 'undefined') return;
  return attachFormResetListener(
    document,
    () => fieldEl?.form ?? rootEl?.closest('form'),
    resetPad,
  );
});

function canvasPoint(event: PointerEvent): { x: number; y: number } {
  if (!canvasEl) return { x: 0, y: 0 };
  return mapPointerToCanvasPoint(
    event.clientX,
    event.clientY,
    canvasEl.getBoundingClientRect(),
    canvasEl.width,
    canvasEl.height,
  );
}

function drawSegment(
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  const context = canvasEl?.getContext('2d');
  if (!context) return;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = 4;
  context.strokeStyle = SIGNATURE_INK_COLOR;
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
}

function handlePointerDown(event: PointerEvent): void {
  if (disabled || encoding || padState === 'committed') return;
  if (!isAcceptedPointerType(event.pointerType, stylusOnly)) return;
  event.preventDefault();
  activePointerId = event.pointerId;
  lastPoint = canvasPoint(event);
  canvasEl?.setPointerCapture?.(event.pointerId);
}

function handlePointerMove(event: PointerEvent): void {
  if (activePointerId !== event.pointerId) return;
  if (disabled || encoding || padState === 'committed') return;
  event.preventDefault();
  const point = canvasPoint(event);
  if (lastPoint) drawSegment(lastPoint, point);
  lastPoint = point;
  padState = 'signed';
}

function endStroke(event: PointerEvent): void {
  if (activePointerId !== event.pointerId) return;
  activePointerId = null;
  lastPoint = null;
}

function writeField(file: File | null): void {
  if (!fieldEl || !name || strategy !== 'data-transfer') return;
  if (!file) {
    clearFileInput(fieldEl);
    return;
  }
  if (!assignFileWithDataTransfer(fieldEl, file)) {
    strategy = detectNativeFileFieldStrategy({
      FormDataEvent: (globalThis as Record<string, unknown>).FormDataEvent,
    });
  }
}

function clear(): void {
  if (!disabled) resetPad();
}

function resetPad(): void {
  const wasCommitted = padState === 'committed';
  encodeRequest += 1;
  encoding = false;
  activePointerId = null;
  lastPoint = null;
  paintPaper();
  padState = 'empty';
  if (wasCommitted) {
    committedFile = null;
    writeField(null);
    onClear?.();
  }
}

function accept(): void {
  const canvas = canvasEl;
  if (disabled || encoding || padState !== 'signed' || !canvas) return;
  encoding = true;
  activePointerId = null;
  lastPoint = null;
  const request = ++encodeRequest;
  const dataUrl = canvas.toDataURL('image/png');
  canvas.toBlob((blob) => {
    // A Clear (or resize) during encoding superseded this request.
    if (request !== encodeRequest) return;
    encoding = false;
    if (!blob) return;
    committedFile = new File([blob], fileName, { type: 'image/png' });
    writeField(committedFile);
    padState = 'committed';
    onCapture?.({ blob, dataUrl });
  }, 'image/png');
}

useControlRegistration(() => {
  const root = rootEl;
  if (!root || interaction === false) return false;
  return {
    controlId,
    subject: interaction?.subject,
    metadata: {
      kind: 'file',
      label: text.region,
      description: interaction?.description,
      sensitivity: interaction?.sensitivity ?? 'sensitive',
      readable: false,
      writable: false,
      capabilities: ['focus', 'reveal', 'highlight', 'explain'],
    },
    focus: () => focusControl(root),
    reveal: () => revealControl(root),
    highlight: (durationMs) => highlightControl(root, durationMs),
    getState: () => ({ disabled }),
  };
});
</script>

<div
  bind:this={rootEl}
  id={resolvedId}
  class="signature-pad {className}"
  class:disabled
  role="group"
  aria-label={text.region}
  data-state={padState}
  data-smrt-file-field={name ? strategy : undefined}
  data-smrt-control={controlId}
  data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={interaction === false ? undefined : interaction?.subject?.type}
  data-smrt-subject-id={interaction === false ? undefined : interaction?.subject?.id}
>
  <canvas
    bind:this={canvasEl}
    {width}
    {height}
    aria-label={padState === 'empty' ? text.canvasEmpty : text.canvasSigned}
    aria-describedby={hintId}
    data-stylus-only={stylusOnly}
    style:background-color={SIGNATURE_PAPER_COLOR}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={endStroke}
    onpointercancel={endStroke}
  ></canvas>

  <p id={hintId} class="hint">{stylusOnly ? text.hintStylus : text.hintAny}</p>
  <p class="message" role="status">{padState === 'committed' ? text.committed : ''}</p>

  <div class="actions">
    <button type="button" class="action" onclick={clear} {disabled}>{text.clear}</button>
    <button
      type="button"
      class="action primary"
      onclick={accept}
      disabled={disabled || encoding || padState !== 'signed'}
    >
      {text.useSignature}
    </button>
  </div>

  {#if name}
    <input
      bind:this={fieldEl}
      class="field"
      type="file"
      hidden
      tabindex="-1"
      name={strategy === 'data-transfer' ? name : undefined}
      data-smrt-capture-field
    />
  {/if}
</div>

<style>
  .signature-pad {
    display: grid;
    gap: var(--smrt-spacing-3);
    width: 100%;
    max-width: 40rem;
    color: var(--smrt-color-on-surface);
  }
  canvas {
    display: block;
    width: 100%;
    height: auto;
    border: 2px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-medium);
    cursor: crosshair;
    touch-action: none;
  }
  .disabled canvas,
  [data-state='committed'] canvas {
    cursor: default;
  }
  .disabled canvas {
    opacity: 0.5;
  }
  .hint,
  .message {
    margin: 0;
  }
  .hint {
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface-variant);
  }
  .message {
    font: var(--smrt-typography-body-large-font);
  }
  .message:empty,
  .field {
    display: none;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-3);
  }
  .action {
    flex: 1 1 auto;
    /* Capture is a touch flow: its actions are touch targets at every
       density, on the shared scale (smrt#3252). */
    min-width: var(--smrt-touch-target-min, 48px);
    min-height: var(--smrt-touch-target-min, 48px);
    padding: 0 var(--smrt-spacing-4);
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-label-large-font);
    cursor: pointer;
  }
  .action.primary {
    flex-grow: 2;
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }
  .action:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }
  .action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  :global(.signature-pad[data-smrt-highlighted='true']) {
    outline: 3px solid var(--smrt-color-tertiary);
    outline-offset: 4px;
  }
</style>
