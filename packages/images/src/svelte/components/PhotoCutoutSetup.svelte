<script lang="ts">
import {
  mountPhotoCutout,
  type PhotoCutoutHandle,
  type PhotoCutoutRig,
} from '@happyvertical/animation';
import { detectFaceLandmarks } from '@happyvertical/images/segmentation';
import { FilePicker, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount } from 'svelte';
import {
  assembleCanadianSplitRig,
  type FaceOutline,
} from '../../photo-cutout-setup.js';

import { isolatePhotoHead } from '../head-isolation.js';
import { M } from '../i18n.js';

const { t } = useI18n();

interface PersistedSetup {
  pngDataUrl: string;
  rig: PhotoCutoutRig;
  savedAt: string;
}
interface Props {
  /** @deprecated Mouth landmarks now run locally; retained for caller compatibility. */
  endpoint?: string;
  segmentationAssets?: string;
  speechPreview?: (
    text: string,
    options: {
      onLevel: (level: number) => void;
      onStart?: () => void;
      signal: AbortSignal;
    },
  ) => Promise<void>;
  saveSetup?: (
    setup: Pick<PersistedSetup, 'pngDataUrl' | 'rig'>,
  ) => Promise<{ savedAt: string }>;
  loadSetup?: () => Promise<PersistedSetup | null>;
}
interface Head {
  file: File;
  url: string;
  width: number;
  height: number;
  outline: FaceOutline;
}
type Stage = 'outline' | 'mouth-landmarks';
let {
  segmentationAssets = '/api/dev-image-segmentation',
  speechPreview,
  saveSetup,
  loadSetup,
}: Props = $props();
let target: HTMLDivElement;
let source = $state<{ file: File; url: string } | null>(null);
let head = $state<Head | null>(null);
let busy = $state<Stage | null>(null);
let failed = $state<Stage | null>(null);
let ready = $state(false);
let open = $state(false);
let elapsed = $state(0);
let message = $state(
  'Choose a photo, then isolate its head on a transparent background.',
);
let request: AbortController | null = null;
let generation = 0;
let mounted: PhotoCutoutHandle | null = null;
let activeAsset = $state<File | null>(null);
let currentRig = $state<PhotoCutoutRig | null>(null);
let persisting = $state<'save' | 'load' | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;
let speechText = $state('Hello, I am your HappyVertical assistant.');
let speaking = $state(false);
let speechStarted = $state(false);
let speechRequest: AbortController | null = null;

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}
function invalidate() {
  generation++;
  request?.abort();
  request = null;
  stopTimer();
  busy = null;
}
function neutralExpression() {
  mounted?.setExpression({ headTiltDegrees: 0, jawTiltDegrees: 0 });
}
function stopSpeech(announce = true) {
  const active = speechRequest;
  active?.abort();
  speechRequest = null;
  speaking = false;
  speechStarted = false;
  open = false;
  mounted?.setMouthOpen(0);
  neutralExpression();
  if (announce && active) message = 'Speech stopped.';
}
function destroyPreview() {
  stopSpeech(false);
  mounted?.destroy();
  mounted = null;
  activeAsset = null;
  currentRig = null;
  ready = false;
  open = false;
}
onMount(() => () => {
  invalidate();
  destroyPreview();
  if (source) URL.revokeObjectURL(source.url);
  if (head) URL.revokeObjectURL(head.url);
});
function select(files: File[]) {
  const file = files[0];
  if (!file) return;
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 8 * 1024 * 1024
  ) {
    message =
      'Choose a PNG, JPEG, or WebP below 8 MB. Your previous photo is still selected.';
    return;
  }
  invalidate();
  destroyPreview();
  if (source) URL.revokeObjectURL(source.url);
  if (head) URL.revokeObjectURL(head.url);
  source = { file, url: URL.createObjectURL(file) };
  head = null;
  failed = null;
  message =
    'Photo is local. Isolate head to remove its background on this device.';
}
const read = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(reader.error ?? new Error('Could not read photo.'));
    reader.readAsDataURL(file);
  });
async function imageAt(url: string) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}
function dataUrlFile(dataUrl: string, name: string) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error('Saved character cutout is not a PNG.');
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return new File([bytes], name, { type: 'image/png' });
}
function mountPreview(rig: PhotoCutoutRig, asset: File, token: number) {
  destroyPreview();
  activeAsset = asset;
  currentRig = rig;
  mounted = mountPhotoCutout(rig, {
    target,
    resolveAsset: async () => asset,
    onError: (error) => {
      if (generation !== token) return;
      ready = false;
      failed = 'mouth-landmarks';
      message = `Character preview failed. ${error.message}`;
    },
  });
  ready = true;
}
async function run(stage: Stage) {
  const selected = source;
  const isolated = head;
  if (!selected || (stage === 'mouth-landmarks' && !isolated)) return;
  stopSpeech(false);
  invalidate();
  const token = generation;
  const controller = new AbortController();
  request = controller;
  busy = stage;
  failed = null;
  elapsed = 0;
  const started = Date.now();
  timer = setInterval(() => {
    elapsed = Math.floor((Date.now() - started) / 1000);
  }, 1000);
  message =
    stage === 'outline'
      ? 'Isolating head on a transparent background…'
      : 'Locating mouth and chin on the transparent head…';
  try {
    if (stage === 'outline') {
      const image = await imageAt(selected.url);
      controller.signal.throwIfAborted();
      const next = await isolatePhotoHead(image, {
        assetBaseUrl: segmentationAssets,
        signal: controller.signal,
        onProgress: (stage) => {
          if (generation === token)
            message =
              stage === 'loading'
                ? 'Loading local head isolation…'
                : 'Isolating original photo pixels on this device…';
        },
      });
      if (generation !== token) return;
      if (head) URL.revokeObjectURL(head.url);
      destroyPreview();
      head = { ...next, url: URL.createObjectURL(next.file) };
      message =
        'Review the transparent head. Continue when the silhouette looks right.';
    } else if (isolated) {
      const image = await imageAt(isolated.url);
      controller.signal.throwIfAborted();
      const landmarks = await detectFaceLandmarks(image, {
        assetBaseUrl: segmentationAssets,
        signal: controller.signal,
        onProgress: (progress) => {
          if (generation === token)
            message =
              progress === 'loading'
                ? 'Loading local face landmarks…'
                : 'Locating lips and chin on this device…';
        },
      });
      if (generation !== token) return;
      const rig = assembleCanadianSplitRig({
        outline: isolated.outline,
        landmarks,
        width: isolated.width,
        height: isolated.height,
        assetId: 'source',
      });
      mountPreview(rig, isolated.file, token);
      message =
        'Character ready. Open the mouth to inspect the horizontal split and vertical gap.';
    }
  } catch (error) {
    if (generation !== token) return;
    failed = stage;
    message = `${stage === 'outline' ? 'Head isolation' : 'Mouth segmentation'} failed. ${error instanceof Error ? error.message : 'Please retry.'}`;
  } finally {
    if (generation === token) {
      stopTimer();
      busy = null;
      request = null;
    }
  }
}
function cancel() {
  const stage = busy;
  invalidate();
  failed = null;
  message =
    stage === 'mouth-landmarks'
      ? 'Mouth segmentation cancelled. Your transparent head is preserved.'
      : 'Head isolation cancelled. Your photo is still selected.';
}
function toggleMouth() {
  open = !open;
  mounted?.setMouthOpen(open ? 1 : 0);
  mounted?.setExpression({
    headTiltDegrees: open ? 4 : 0,
    jawTiltDegrees: open ? 7 : 0,
  });
}
async function saveCharacter() {
  if (!saveSetup || !activeAsset || !currentRig || persisting) return;
  const token = generation;
  const asset = activeAsset;
  const rig = currentRig;
  persisting = 'save';
  try {
    const result = await saveSetup({ pngDataUrl: await read(asset), rig });
    if (generation === token)
      message = `Character saved locally at ${new Date(result.savedAt).toLocaleTimeString()}.`;
  } catch (cause) {
    if (generation === token)
      message = `Character save failed. ${cause instanceof Error ? cause.message : 'Please retry.'}`;
  } finally {
    persisting = null;
  }
}
async function loadCharacter() {
  if (!loadSetup || persisting) return;
  const token = generation;
  persisting = 'load';
  try {
    const saved = await loadSetup();
    if (generation !== token) return;
    if (!saved) {
      message = 'No saved character setup is available yet.';
      return;
    }
    invalidate();
    const mountToken = generation;
    const asset = dataUrlFile(saved.pngDataUrl, 'saved-character-cutout.png');
    mountPreview(saved.rig, asset, mountToken);
    message = `Saved character loaded from ${new Date(saved.savedAt).toLocaleTimeString()}.`;
  } catch (cause) {
    if (generation === token)
      message = `Character load failed. ${cause instanceof Error ? cause.message : 'Please retry.'}`;
  } finally {
    persisting = null;
  }
}
async function playSpeech() {
  if (!speechPreview || !ready || speaking || !speechText.trim()) return;
  const controller = new AbortController();
  const token = generation;
  speechRequest = controller;
  speaking = true;
  speechStarted = false;
  open = false;
  message = 'Preparing speech…';
  const current = () =>
    speechRequest === controller &&
    !controller.signal.aborted &&
    generation === token;
  try {
    await speechPreview(speechText, {
      signal: controller.signal,
      onStart: () => {
        if (current()) {
          speechStarted = true;
          message = 'Speaking…';
        }
      },
      onLevel: (level) => {
        if (current()) {
          const reduced = matchMedia(
            '(prefers-reduced-motion: reduce)',
          ).matches;
          const gain = reduced
            ? 0
            : Math.min(1, Math.sqrt(Math.max(0, level)) * 1.25);
          mounted?.setMouthOpen(gain);
          mounted?.setExpression({
            headTiltDegrees: Math.sin(Date.now() / 220) * 5 * gain,
            jawTiltDegrees: gain * 7,
          });
        }
      },
    });
    if (current()) message = 'Speech complete.';
  } catch (cause) {
    if (current())
      message =
        cause instanceof Error ? cause.message : 'Speech preview failed.';
  } finally {
    if (speechRequest === controller) {
      speechRequest = null;
      speaking = false;
      speechStarted = false;
      open = false;
      mounted?.setMouthOpen(0);
      neutralExpression();
    }
  }
}
</script>

<section class="setup" aria-busy={busy !== null} aria-labelledby="cutout-title">
  <h2 id="cutout-title">{t(M['images.photo_cutout_setup.title'])}</h2>
  <ol class="steps" aria-label={t(M['images.photo_cutout_setup.steps_label'])}>
    <li class:current={!source && !ready} class:complete={source !== null || ready} aria-current={!source && !ready ? 'step' : undefined}>{t(M['images.photo_cutout_setup.step_choose'])}</li>
    <li class:current={source !== null && !head && !ready} class:complete={head !== null || ready} aria-current={source !== null && !head && !ready ? 'step' : undefined}>{t(M['images.photo_cutout_setup.step_isolate'])}</li>
    <li class:current={head !== null && !ready} class:complete={ready} aria-current={head !== null && !ready ? 'step' : undefined}>{t(M['images.photo_cutout_setup.step_mouth'])}</li>
    <li class:current={ready} aria-current={ready ? 'step' : undefined}>{t(M['images.photo_cutout_setup.step_save'])}</li>
  </ol>
  <p class:error={failed !== null} class:success={ready} role={failed ? 'alert' : undefined} aria-live={failed ? 'assertive' : 'polite'}>{message}{#if busy} ({elapsed}s){/if}</p>
  <FilePicker accept="image/png,image/jpeg,image/webp" label={t(M['images.photo_cutout_setup.choose_photo'])} description={t(M['images.photo_cutout_setup.photo_formats'])} aria-label={t(M['images.photo_cutout_setup.choose_photo'])} onchangefiles={select} disabled={persisting !== null} />
  <div class="workflow-actions">
    <div class="primary-action">
      {#if ready && saveSetup}<Button onclick={saveCharacter} disabled={persisting !== null}>{persisting === 'save' ? 'Saving…' : 'Save character'}</Button>
      {:else if ready}<Button onclick={toggleMouth}>{open ? 'Close mouth' : 'Open mouth'}</Button>
      {:else if !head}<Button onclick={() => run('outline')} disabled={!source || busy !== null}>{failed === 'outline' ? 'Retry head isolation' : 'Isolate head'}</Button>
      {:else if !ready}<Button onclick={() => run('mouth-landmarks')} disabled={busy !== null}>{failed === 'mouth-landmarks' ? 'Retry mouth segmentation' : 'Continue: segment mouth'}</Button>
      {/if}
      {#if busy}<span class="spinner" aria-label={busy === 'outline' ? 'Isolating head' : 'Segmenting mouth'}></span><Button variant="secondary" onclick={cancel}>Cancel</Button>{/if}
    </div>
    {#if ready && saveSetup}<p class="save-hint">{t(M['images.photo_cutout_setup.save_hint'])}</p>{/if}
    <div class="secondary-actions" aria-label={t(M['images.photo_cutout_setup.options_label'])}>
      {#if head}<Button variant="secondary" onclick={() => run('outline')} disabled={busy !== null || persisting !== null}>{t(M['images.photo_cutout_setup.redo_head'])}</Button>{/if}
      {#if head && ready}<Button variant="secondary" onclick={() => run('mouth-landmarks')} disabled={busy !== null || persisting !== null}>{t(M['images.photo_cutout_setup.redo_mouth'])}</Button>{/if}
      {#if ready && saveSetup}<Button variant="secondary" onclick={toggleMouth}>{open ? 'Close mouth' : 'Open mouth'}</Button>{/if}
      {#if loadSetup}<Button variant="secondary" onclick={loadCharacter} disabled={busy !== null || persisting !== null}>{persisting === 'load' ? 'Loading…' : 'Load saved character'}</Button>{/if}
    </div>
  </div>
  {#if ready && speechPreview}<div class="speech"><label>{t(M['images.photo_cutout_setup.preview_speech'])} <Textarea bind:value={speechText} maxlength={500} disabled={speaking} /></label><Button onclick={playSpeech} disabled={speaking || !speechText.trim()}>{speaking ? speechStarted ? 'Speaking…' : 'Preparing…' : 'Play speech'}</Button>{#if speaking}<Button onclick={() => stopSpeech()}>{t(M['images.photo_cutout_setup.stop_speech'])}</Button>{/if}</div>{/if}
  <div class="previews">
    {#if head}<figure><figcaption>{t(M['images.photo_cutout_setup.transparent_head'])}</figcaption><img class="checkerboard" src={head.url} alt={t(M['images.photo_cutout_setup.isolated_head_alt'])} /></figure>
    {:else if source}<figure><figcaption>{t(M['images.photo_cutout_setup.step_choose'])}</figcaption><img src={source.url} alt={t(M['images.photo_cutout_setup.source_alt'])} /></figure>{/if}
    <div bind:this={target} class="preview-target" class:preview={ready} class:checkerboard={ready} aria-label={ready ? t(M['images.photo_cutout_setup.preview_label']) : undefined} aria-hidden={!ready}></div>
  </div>
</section>

<style>
.setup { max-width: 42rem; margin: var(--smrt-spacing-6, 1.5rem) auto; padding: var(--smrt-spacing-5, 1.25rem); border: 1px solid var(--smrt-color-outline-variant, #64748b); border-radius: var(--smrt-radius-xl, 12px); }
.steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--smrt-spacing-2, .5rem); padding: 0; margin: var(--smrt-spacing-4, 1rem) 0; list-style: none; color: var(--smrt-color-on-surface-variant, #475569); font-size: var(--smrt-typography-body-small-size, .875rem); }
.steps li { padding-bottom: var(--smrt-spacing-1, .25rem); border-bottom: 2px solid var(--smrt-color-outline-variant, #64748b); }
.steps .current { color: var(--smrt-color-primary, #1d4ed8); border-color: var(--smrt-color-primary, #1d4ed8); font-weight: var(--smrt-typography-weight-semibold, 600); }
.steps .complete { color: var(--smrt-color-success, #166534); }
.workflow-actions { margin: var(--smrt-spacing-4, 1rem) 0; }
.primary-action, .secondary-actions, .speech { display: flex; flex-wrap: wrap; align-items: center; gap: var(--smrt-spacing-3, .75rem); }
.secondary-actions { margin-top: var(--smrt-spacing-3, .75rem); }
.save-hint { margin: var(--smrt-spacing-2, .5rem) 0 0; color: var(--smrt-color-on-surface-variant, #475569); font-size: var(--smrt-typography-body-small-size, .875rem); }
.speech { margin-top: var(--smrt-spacing-4, 1rem); }
.previews { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--smrt-spacing-4, 1rem); align-items: start; }
figure { margin: 0; }
figure figcaption { margin-bottom: var(--smrt-spacing-2, .5rem); font-size: var(--smrt-typography-body-small-size, .875rem); }
.setup img, .preview :global(svg) { display: block; width: 100%; height: auto; max-height: 18rem; object-fit: contain; }
.preview, .preview-target { min-width: 0; }
.preview-target:not(.preview) { display: none; }
.checkerboard { background-color: var(--smrt-color-surface, #fff); background-image: linear-gradient(45deg, var(--smrt-color-surface-container-highest, #ddd) 25%, transparent 25%), linear-gradient(-45deg, var(--smrt-color-surface-container-highest, #ddd) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--smrt-color-surface-container-highest, #ddd) 75%), linear-gradient(-45deg, transparent 75%, var(--smrt-color-surface-container-highest, #ddd) 75%); background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0; }
.error { color: var(--smrt-color-error, #b91c1c); font-weight: var(--smrt-typography-weight-semibold, 600); }
.success { color: var(--smrt-color-success, #166534); }
.spinner { width: 1rem; height: 1rem; border: 2px solid currentColor; border-right-color: transparent; border-radius: var(--smrt-radius-full, 9999px); animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-right-color: currentColor; } }
@media (max-width: 40rem) { .steps { grid-template-columns: repeat(2, 1fr); } .previews { grid-template-columns: 1fr; } }
</style>
