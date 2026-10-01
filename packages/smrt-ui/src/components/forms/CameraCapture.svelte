<!--
  Live camera capture through `getUserMedia`, for photos taken inside a form.

  The component owns the whole flow: request the camera, preview the live
  stream, capture a still, and let the user review and retake before the photo
  is committed. A committed photo leaves through `onCapture({ blob, dataUrl })`
  and, when `name` is set, is posted by a plain native form as a file field
  (`native-file-field.ts` explains the DataTransfer and `formdata`-event
  strategies). Permission denied, no camera, unsupported browser and other
  errors are distinct rendered states.

  The request/classify/release lifecycle lives in the framework-free
  `camera-capture-session.ts`. The `$effect` below depends only on `disabled`
  and `facingMode`, never on the rendered state: the state is written from the
  session's async continuation, so reading it there would tear the stream down
  and restart it in a loop. Its cleanup stops every track on `disabled` and on
  unmount alike, so the camera light never stays on.

  `<input type="file" capture>` is NOT the default path: it hands control to the
  OS picker (no live preview, gallery access, no in-app review). It is available
  only through the opt-in `fileInputFallback`, and only for browsers without
  `getUserMedia`.

  Ported from teamworks-os `CameraCapture.svelte`, smrt#3290.
-->
<script lang="ts">
import { onMount, untrack } from 'svelte';
import { M, useI18n } from '../../i18n/index.js';
import {
  type CameraFacingMode,
  createCameraSession,
} from './camera-capture-session.js';
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
  clearFileInput,
  detectNativeFileFieldStrategy,
  fileNameForType,
  type NativeFileFieldStrategy,
} from './native-file-field.js';
import type {
  CameraCaptureLabels,
  CameraCaptureState,
  CaptureResult,
} from './types.js';
import { useControlRegistration } from './use-control-registration.svelte.js';

export interface Props {
  /** Which camera to request. Re-requested on change while live. */
  facingMode?: CameraFacingMode;
  /** Stops the camera and disables every action; a held photo is kept. */
  disabled?: boolean;
  /** Called when the user commits a photo with "Use photo". */
  onCapture?: (result: CaptureResult) => void;
  /** Called when a committed photo is discarded by "Retake". */
  onClear?: () => void;
  /** Field name: the committed photo posts as a file in a native form. */
  name?: string;
  /** Posted file name. Defaults to `photo.<ext>` for the image type. */
  fileName?: string;
  /** Encoded image type. */
  imageType?: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Encoder quality for lossy types, 0 to 1. */
  quality?: number;
  /**
   * Opt in to `<input type="file" capture>` for browsers without
   * `getUserMedia`. Off by default: without it those browsers render the
   * unsupported state.
   */
  fileInputFallback?: boolean;
  /** Text overrides; defaults come from the `ui` i18n catalog. */
  labels?: Partial<CameraCaptureLabels>;
  /** DOM id of the component root. */
  id?: string;
  /** CSS class to apply to the component root. */
  class?: string;
  /** Interaction options or false to disable registration. */
  interaction?: ControlInteractionOptions | false;
}

let {
  facingMode = 'environment',
  disabled = false,
  onCapture,
  onClear,
  name,
  fileName,
  imageType = 'image/jpeg',
  quality = 0.92,
  fileInputFallback = false,
  labels,
  id,
  class: className = '',
  interaction,
}: Props = $props();

const { t } = useI18n();
const text = $derived<CameraCaptureLabels>({
  region: t(M['ui.camera_capture.region']),
  preview: t(M['ui.camera_capture.preview']),
  starting: t(M['ui.camera_capture.starting']),
  off: t(M['ui.camera_capture.off']),
  unsupported: t(M['ui.camera_capture.unsupported']),
  permissionDenied: t(M['ui.camera_capture.permission_denied']),
  noCamera: t(M['ui.camera_capture.no_camera']),
  error: t(M['ui.camera_capture.error']),
  retry: t(M['ui.camera_capture.retry']),
  capture: t(M['ui.camera_capture.capture']),
  retake: t(M['ui.camera_capture.retake']),
  usePhoto: t(M['ui.camera_capture.use_photo']),
  reviewAlt: t(M['ui.camera_capture.review_alt']),
  committedAlt: t(M['ui.camera_capture.committed_alt']),
  committed: t(M['ui.camera_capture.committed']),
  choosePhoto: t(M['ui.camera_capture.choose_photo']),
  ...labels,
});

const instanceId = $props.id();
const interactionContext = tryGetControlInteractionContext();
const resolvedId = $derived(id ?? `smrt-camera-${instanceId}`);
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name ?? resolvedId),
);
const resolvedFileName = $derived(
  fileName ?? fileNameForType('photo', imageType),
);

let cameraState = $state<CameraCaptureState>(
  untrack(() => disabled) ? 'off' : 'starting',
);
let previewUrl = $state('');
let unsupportedApi = $state(false);
let strategy = $state<NativeFileFieldStrategy>('data-transfer');
let rootEl = $state<HTMLDivElement | null>(null);
let videoEl = $state<HTMLVideoElement | null>(null);
let fieldEl = $state<HTMLInputElement | null>(null);
let pending: CaptureResult | null = null;
let committedFile: File | null = null;
let fallbackReads = 0;

const fallbackActive = $derived(unsupportedApi && fileInputFallback);
const message = $derived.by(() => {
  switch (cameraState) {
    case 'off':
      return text.off;
    case 'starting':
      return text.starting;
    case 'unsupported':
      return text.unsupported;
    case 'permission-denied':
      return text.permissionDenied;
    case 'no-camera':
      return text.noCamera;
    case 'error':
      return text.error;
    case 'committed':
      return text.committed;
    default:
      return '';
  }
});
const isProblem = $derived(
  cameraState === 'unsupported' ||
    cameraState === 'permission-denied' ||
    cameraState === 'no-camera' ||
    cameraState === 'error',
);

const session = createCameraSession({
  mediaDevices:
    typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
});

function holdsPhoto(): boolean {
  return cameraState === 'reviewing' || cameraState === 'committed';
}

async function startCamera(): Promise<void> {
  cameraState = 'starting';
  const result = await session.start(facingMode);
  if (!result.ok) {
    // `cancelled`: a stop() (unmount, `disabled`, a newer start) superseded
    // this request and the session already released what it acquired.
    if (result.kind === 'cancelled') return;
    if (result.kind === 'unsupported') {
      unsupportedApi = true;
      cameraState = fileInputFallback ? 'fallback' : 'unsupported';
      return;
    }
    cameraState = result.kind;
    return;
  }
  const stream = result.stream;
  if (videoEl) {
    videoEl.srcObject = stream;
    try {
      await videoEl.play();
    } catch {
      // Autoplay policy (or a test DOM) can reject play(); the stream is live.
    }
  }
  // A stop() during play() released this stream; do not resurrect the state.
  if (session.stream !== stream) return;
  cameraState = 'streaming';
}

function stopStream(): void {
  session.stop();
  if (videoEl) videoEl.srcObject = null;
}

$effect(() => {
  const off = disabled;
  void facingMode; // tracked: a new facing mode re-requests the camera
  if (off) {
    untrack(() => {
      if (!holdsPhoto() && !unsupportedApi) cameraState = 'off';
    });
    return;
  }
  untrack(() => {
    if (!holdsPhoto() && !unsupportedApi) void startCamera();
  });
  return () => stopStream();
});

onMount(() => {
  strategy = detectNativeFileFieldStrategy();
});

$effect(() => {
  if (strategy !== 'formdata-event' || typeof document === 'undefined') return;
  return attachFormDataFallback(document, () =>
    name && fieldEl && !fallbackActive
      ? { form: fieldEl.form, name, file: committedFile }
      : null,
  );
});

function writeField(file: File | null): void {
  if (!fieldEl || !name || strategy !== 'data-transfer') return;
  if (!file) {
    clearFileInput(fieldEl);
    return;
  }
  if (!assignFileWithDataTransfer(fieldEl, file)) {
    // The probe passed but this engine refused the real assignment: drop to
    // the next strategy, which reads `committedFile` at submit time.
    strategy = detectNativeFileFieldStrategy({
      FormDataEvent: (globalThis as Record<string, unknown>).FormDataEvent,
    });
  }
}

function capture(): void {
  const video = videoEl;
  if (disabled || !video || !session.stream) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const context = canvas.getContext('2d');
  if (!context) {
    stopStream();
    cameraState = 'error';
    return;
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL(imageType, quality);
  // The frame is on the canvas: release the camera now, not after encoding.
  stopStream();
  canvas.toBlob(
    (blob) => {
      if (!blob) {
        cameraState = 'error';
        return;
      }
      pending = { blob, dataUrl };
      previewUrl = dataUrl;
      cameraState = 'reviewing';
    },
    imageType,
    quality,
  );
}

function usePhoto(): void {
  if (disabled || !pending) return;
  const result = pending;
  committedFile = new File([result.blob], resolvedFileName, {
    type: result.blob.type || imageType,
  });
  writeField(committedFile);
  cameraState = 'committed';
  onCapture?.(result);
}

function retake(): void {
  if (disabled) return;
  const wasCommitted = cameraState === 'committed';
  pending = null;
  previewUrl = '';
  if (wasCommitted) {
    committedFile = null;
    writeField(null);
    onClear?.();
  }
  void startCamera();
}

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function handleFallbackChange(
  event: Event & { currentTarget: HTMLInputElement },
): Promise<void> {
  const file = event.currentTarget.files?.[0] ?? null;
  const read = ++fallbackReads;
  if (!file) {
    if (cameraState === 'committed') {
      committedFile = null;
      previewUrl = '';
      cameraState = 'fallback';
      onClear?.();
    }
    return;
  }
  let dataUrl = '';
  try {
    dataUrl = await readDataUrl(file);
  } catch {
    // A preview is a convenience; the chosen file still posts and is reported.
  }
  if (read !== fallbackReads) return;
  committedFile = file;
  previewUrl = dataUrl;
  cameraState = 'committed';
  onCapture?.({ blob: file, dataUrl });
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
  class="camera-capture {className}"
  class:disabled
  role="group"
  aria-label={text.region}
  data-state={cameraState}
  data-smrt-file-field={name ? (fallbackActive ? 'file-input' : strategy) : undefined}
  data-smrt-control={controlId}
  data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={interaction === false ? undefined : interaction?.subject?.type}
  data-smrt-subject-id={interaction === false ? undefined : interaction?.subject?.id}
>
  <div class="stage" class:empty={cameraState !== 'streaming' && !previewUrl}>
    <video
      bind:this={videoEl}
      class="media"
      class:hidden={cameraState !== 'streaming'}
      aria-label={text.preview}
      autoplay
      playsinline
      muted
    ></video>
    {#if previewUrl && (cameraState === 'reviewing' || cameraState === 'committed')}
      <img
        class="media"
        src={previewUrl}
        alt={cameraState === 'committed' ? text.committedAlt : text.reviewAlt}
      />
    {/if}
  </div>

  <p class="message" class:problem={isProblem} role="status">{message}</p>

  <div class="actions">
    {#if cameraState === 'permission-denied' || cameraState === 'no-camera' || cameraState === 'error'}
      <button type="button" class="action" {disabled} onclick={() => void startCamera()}>
        {text.retry}
      </button>
    {:else if cameraState === 'streaming'}
      <button type="button" class="action primary" {disabled} onclick={capture}>
        {text.capture}
      </button>
    {:else if cameraState === 'reviewing'}
      <button type="button" class="action" {disabled} onclick={retake}>{text.retake}</button>
      <button type="button" class="action primary" {disabled} onclick={usePhoto}>
        {text.usePhoto}
      </button>
    {:else if cameraState === 'committed' && !fallbackActive}
      <button type="button" class="action" {disabled} onclick={retake}>{text.retake}</button>
    {/if}
    {#if fallbackActive}
      <label class="action primary picker" class:disabled>
        <input
          class="visually-hidden"
          type="file"
          accept="image/*"
          capture={facingMode}
          {name}
          {disabled}
          onchange={handleFallbackChange}
        />
        <span>{cameraState === 'committed' ? text.retake : text.choosePhoto}</span>
      </label>
    {/if}
  </div>

  {#if name && !fallbackActive}
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
  .camera-capture {
    /* Swap for the shared touch-target token once smrt#3252 lands. */
    --smrt-capture-target-size: 2.75rem;
    display: grid;
    gap: var(--smrt-spacing-3);
    width: 100%;
    max-width: 40rem;
    color: var(--smrt-color-on-surface);
  }
  .stage {
    position: relative;
    display: grid;
    overflow: hidden;
    aspect-ratio: 4 / 3;
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-scrim);
  }
  .stage.empty {
    background: var(--smrt-color-surface-container);
  }
  .media {
    grid-area: 1 / 1;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .media.hidden,
  .field {
    display: none;
  }
  .message {
    margin: 0;
    font: var(--smrt-typography-body-large-font);
  }
  .message:empty {
    display: none;
  }
  .message.problem {
    color: var(--smrt-color-error);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-3);
  }
  .actions:empty {
    display: none;
  }
  .action {
    position: relative;
    flex: 1 1 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--smrt-capture-target-size);
    min-height: var(--smrt-capture-target-size);
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
  .action:focus-visible,
  .picker:has(input:focus-visible) {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }
  .action:disabled,
  .picker.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  :global(.camera-capture[data-smrt-highlighted='true']) {
    outline: 3px solid var(--smrt-color-tertiary);
    outline-offset: 4px;
  }
</style>
