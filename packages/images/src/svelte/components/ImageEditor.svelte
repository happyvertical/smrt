<script lang="ts">
import { Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type {
  ImageConvertRequest,
  ImageCropRequest,
  ImageEditorClient,
  ImageLike,
  ImageResizeRequest,
} from '../image-clients';

const { t } = useI18n();

let {
  image = null,
  apiBaseUrl = '/api/v1',
  client = undefined,
  onSave = undefined,
  onCancel = undefined,
}: {
  image?: ImageLike | null;
  apiBaseUrl?: string;
  client?: ImageEditorClient;
  onSave?: (image: ImageLike) => void;
  onCancel?: () => void;
} = $props();

let mode: 'standard' | 'ai' = $state('standard');

let isEditingDimensions = $state(false);
let isCropping = $state(false);

// Set default state empty and populate through effect
let width = $state(800);
let height = $state(600);
let cropX = $state(0);
let cropY = $state(0);
let cropW = $state(800);
let cropH = $state(600);
let format = $state('webp');

// Track if we've initialized dimensions for the *current* image
let lastImageId = $state<string | undefined>(undefined);

// AI Mode options
let prompt = $state('');

let isProcessing = $state(false);
let error: string | null = $state(null);
let successMessage: string | null = $state(null);

async function postEditorRequest<TPayload extends object>(
  endpoint: string,
  payload: TPayload,
) {
  const res = await fetch(`${apiBaseUrl}/images/${image?.id}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let errText = await res.text();
    if (errText.trim().startsWith('<'))
      errText = `Server returned ${res.status} ${res.statusText}`;
    throw new Error(errText);
  }

  return (await res.json()) as { image: ImageLike };
}

$effect(() => {
  // Only reset dimensions if the actual image selection changes
  if (image?.id && image.id !== lastImageId) {
    lastImageId = image.id;
    resetDimensions();
  }
});

function resetDimensions() {
  if (!image) return;
  width = image.width;
  height = image.height;
  cropW = image.width;
  cropH = image.height;
  isEditingDimensions = false;
  isCropping = false;
}

async function handleResize() {
  if (!image) return;
  isProcessing = true;
  error = null;
  successMessage = null;

  try {
    const payload: ImageResizeRequest = { width, height };
    const data = client
      ? await client.resize(image.id, payload)
      : await postEditorRequest('resize', payload);

    successMessage = 'Image resized successfully (new derivative created).';
    if (onSave) onSave(data.image);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to resize image';
  } finally {
    isProcessing = false;
  }
}

async function handleCrop() {
  if (!image) return;
  isProcessing = true;
  error = null;
  successMessage = null;

  try {
    const payload: ImageCropRequest = {
      x: cropX,
      y: cropY,
      w: cropW,
      h: cropH,
    };
    const data = client
      ? await client.crop(image.id, payload)
      : await postEditorRequest('crop', payload);

    successMessage = 'Image cropped successfully (new derivative created).';
    if (onSave) onSave(data.image);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to crop image';
  } finally {
    isProcessing = false;
  }
}

async function handleConvert() {
  if (!image) return;
  isProcessing = true;
  error = null;
  successMessage = null;

  try {
    const payload: ImageConvertRequest = { format };
    const data = client
      ? await client.convert(image.id, payload)
      : await postEditorRequest('convert', payload);

    successMessage = `Image converted to ${format} successfully (new derivative created).`;
    if (onSave) onSave(data.image);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to convert image';
  } finally {
    isProcessing = false;
  }
}

async function handleAIEdit() {
  if (!image || !prompt) return;
  isProcessing = true;
  error = null;
  successMessage = null;

  try {
    const data = client
      ? await client.edit(image.id, { prompt })
      : await postEditorRequest('edit', { prompt });

    successMessage = 'AI edit complete (new derivative created).';
    if (onSave) onSave(data.image);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to apply AI edit';
  } finally {
    isProcessing = false;
  }
}
</script>

<div class="smrt-image-editor__root" data-smrt-component="ImageEditor">
  <div class="smrt-image-editor__header" data-smrt-part="header">
    <h3>{t(M['images.image_editor.title'])}</h3>
    {#if onCancel}
      <Button variant="ghost" size="sm" class="smrt-image-editor__close" onclick={onCancel}>×</Button>
    {/if}
  </div>

  {#if !image}
    <div class="smrt-image-editor__empty" data-smrt-part="empty">{t(M['images.image_editor.no_image_selected'])}</div>
  {:else}
    <div class="smrt-image-editor__content" data-smrt-part="body">
      <div class="smrt-image-editor__preview" data-smrt-part="panel" style="background-image: url({image.url})">
        <!-- Optional: Interactive crop overlay could go here -->
      </div>
      
      <div class="smrt-image-editor__controls" data-smrt-part="panel">
        <div class="smrt-image-editor__modes" data-smrt-part="nav">
          <Button
            variant={mode === 'standard' ? 'primary' : 'ghost'}
            class="smrt-image-editor__mode-button"
            onclick={() => (mode = 'standard')}
          >{t(M['images.image_editor.standard_tools'])}</Button>
          <Button
            variant={mode === 'ai' ? 'primary' : 'ghost'}
            class="smrt-image-editor__mode-button"
            onclick={() => (mode = 'ai')}
          >{t(M['images.image_editor.ai_edit'])}</Button>
        </div>

        {#if error}
          <div class="smrt-image-editor__error" data-smrt-part="error">{error}</div>
        {/if}
        {#if successMessage}
          <div class="smrt-image-editor__success" data-smrt-part="status">{successMessage}</div>
        {/if}

        {#if mode === 'standard'}
          <!-- Standard Operations -->
          <div class="smrt-image-editor__tool" data-smrt-part="group">
            <h4>Resize</h4>
            <div class="smrt-image-editor__row" data-smrt-part="row">
              <label>Width <Input type="number" class="smrt-image-editor__dimension-input" bind:value={width} onfocus={() => isEditingDimensions = true} /></label>
              <label>Height <Input type="number" class="smrt-image-editor__dimension-input" bind:value={height} onfocus={() => isEditingDimensions = true} /></label>
              <Button variant="ghost" class="smrt-image-editor__tonal-button" disabled={isProcessing} onclick={handleResize}>{t(M['images.image_editor.apply_resize'])}</Button>
            </div>
            {#if isEditingDimensions}
               <div class="smrt-image-editor__row" data-smrt-part="row"><Button variant="ghost" size="sm" class="smrt-image-editor__text-button" onclick={resetDimensions}>{t(M['images.image_editor.reset_dimensions'])}</Button></div>
            {/if}
          </div>

          <div class="smrt-image-editor__tool" data-smrt-part="group">
            <h4>Crop</h4>
            <div class="smrt-image-editor__row" data-smrt-part="row">
              <label>X <Input type="number" class="smrt-image-editor__dimension-input" bind:value={cropX} onfocus={() => isCropping = true} /></label>
              <label>Y <Input type="number" class="smrt-image-editor__dimension-input" bind:value={cropY} onfocus={() => isCropping = true} /></label>
            </div>
            <div class="smrt-image-editor__row" data-smrt-part="row">
              <label>W <Input type="number" class="smrt-image-editor__dimension-input" bind:value={cropW} onfocus={() => isCropping = true} /></label>
              <label>H <Input type="number" class="smrt-image-editor__dimension-input" bind:value={cropH} onfocus={() => isCropping = true} /></label>
              <Button variant="ghost" class="smrt-image-editor__tonal-button" disabled={isProcessing} onclick={handleCrop}>{t(M['images.image_editor.apply_crop'])}</Button>
            </div>
            {#if isCropping}
               <div class="smrt-image-editor__row" data-smrt-part="row"><Button variant="ghost" size="sm" class="smrt-image-editor__text-button" onclick={resetDimensions}>{t(M['images.image_editor.reset_dimensions'])}</Button></div>
            {/if}
          </div>

          <div class="smrt-image-editor__tool" data-smrt-part="group">
            <h4>{t(M['images.image_editor.convert_format'])}</h4>
            <div class="smrt-image-editor__row" data-smrt-part="row">
              <Select class="smrt-image-editor__format" bind:value={format}>
                <option value="webp">WebP</option>
                <option value="jpeg">JPEG</option>
                <option value="png">PNG</option>
              </Select>
              <Button variant="ghost" class="smrt-image-editor__tonal-button" disabled={isProcessing} onclick={handleConvert}>Convert</Button>
            </div>
          </div>
        {:else}
          <!-- AI Operations -->
          <div class="smrt-image-editor__tool" data-smrt-part="group">
            <h4>{t(M['images.image_editor.ai_powered_edit'])}</h4>
            <p class="smrt-image-editor__hint" data-smrt-part="description">{t(M['images.image_editor.ai_powered_edit_hint'])}</p>
            <Textarea
              class="smrt-image-editor__prompt"
              bind:value={prompt}
              placeholder={t(M['images.image_editor.ai_prompt_placeholder'])}
              rows={4}
            />
            <Button
              variant="primary"
              class="smrt-image-editor__primary-button"
              disabled={isProcessing || !prompt.trim()}
              onclick={handleAIEdit}
            >
              {isProcessing ? 'Generating...' : 'Apply AI Edit'}
            </Button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-image-editor__root {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.5rem;
  }
  .smrt-image-editor__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 1rem;
    margin-bottom: 0.5rem;
  }
  .smrt-image-editor__header h3 {
    margin: 0;
  }
  .smrt-image-editor__empty {
    padding: 2rem;
  }
  .smrt-image-editor__content {
    display: flex;
    flex-wrap: wrap;
    gap: 2rem;
  }
  .smrt-image-editor__preview {
    flex: 1;
    min-width: 300px;
    min-height: 300px;
  }
  .smrt-image-editor__controls {
    flex: 1;
    min-width: 300px;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  /* Segmented button style for tabs */
  .smrt-image-editor__modes {
    display: flex;
    padding: 0.25rem;
    gap: 0.25rem;
  }
  /* The mode toggles are migrated Buttons (variant primary = active, ghost =
  inactive). Keep the segmented-pill sizing by piercing into each Button's
  rendered <button> (see #1589 scoping rule). */
  .smrt-image-editor__modes :global(.smrt-image-editor__mode-button) {
    flex: 1;
    padding: 0.6rem 1rem;
  }
  .smrt-image-editor__tool h4 {
    margin: 0 0 1rem 0;
  }
  .smrt-image-editor__row {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }
  .smrt-image-editor__row label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  /* Layout-only overrides for the migrated form primitives. The Input / Select /
  Textarea primitives own the visual styling (background, border, focus ring);
  these :global() rules only pierce their rendered controls to constrain box
  size and spacing (see #1589 scoping rule). */
  .smrt-image-editor__row label :global(.smrt-image-editor__dimension-input) {
    width: 90px;
  }
  /* Size the format Select to its content instead of the primitive's full-width
  default so it sits inline beside the Convert button in the flex row. */
  .smrt-image-editor__row :global(.smrt-image-editor__format) {
    width: auto;
  }
  .smrt-image-editor__tool :global(.smrt-image-editor__prompt) {
    margin-bottom: 1rem;
  }
  /* Migrated Buttons keep their bespoke filled-tonal / text-link / pill looks.
  :global() pierces into each Button's rendered <button> (see #1589). */
  .smrt-image-editor__tool :global(.smrt-image-editor__tonal-button) {
    padding: 0.6rem 1.2rem;
    margin-top: 1.25rem;
  }
  .smrt-image-editor__tool :global(.smrt-image-editor__text-button) {
    padding: 0;
  }
  .smrt-image-editor__tool :global(.smrt-image-editor__primary-button) {
    padding: 0.6rem 1.5rem;
  }
  .smrt-image-editor__hint {
    margin: 0 0 0.5rem 0;
  }
  .smrt-image-editor__error {
    padding: 0.5rem;
  }
  .smrt-image-editor__success {
    padding: 0.5rem;
  }
}

@layer smrt.theme {
  .smrt-image-editor__root {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    border-radius: var(--smrt-radius-lg);
    border: var(--smrt-hairline);
  }
  .smrt-image-editor__header {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-image-editor__header h3 {
    font-size: var(--smrt-typography-title-medium-size, 1.15rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  /* The migrated close Button keeps ghost styling; only bump the × glyph size.
  :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-image-editor__header :global(.smrt-image-editor__close) {
    color: inherit;
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    line-height: 1;
  }
  .smrt-image-editor__empty {
    text-align: center;
    color: var(--smrt-color-outline);
  }
  .smrt-image-editor__preview {
    background-size: contain;
    background-position: center;
    background-repeat: no-repeat;
    background-color: var(--smrt-color-surface-container-high);
    border-radius: var(--smrt-radius-md);
    border: 1px dashed var(--smrt-color-outline-variant);
  }
  /* Segmented button style for tabs */
  .smrt-image-editor__modes {
    background: var(--smrt-color-surface-container-high);
    border-radius: var(--smrt-radius-full);
  }
  /* The mode toggles are migrated Buttons (variant primary = active, ghost =
  inactive). Keep the segmented-pill sizing by piercing into each Button's
  rendered <button> (see #1589 scoping rule). */
  .smrt-image-editor__modes :global(.smrt-image-editor__mode-button) {
    font-weight: var(--smrt-typography-weight-medium, 500);
    border-radius: var(--smrt-radius-full);
  }
  .smrt-image-editor__tool h4 {
    font-size: var(--smrt-typography-title-medium-size, 0.95rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-image-editor__row label {
    font-size: var(--smrt-typography-label-medium-size, 0.8rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-outline);
  }
  /* Migrated Buttons keep their bespoke filled-tonal / text-link / pill looks.
  :global() pierces into each Button's rendered <button> (see #1589). */
  .smrt-image-editor__tool :global(.smrt-image-editor__tonal-button) {
    background: var(--smrt-color-surface-container-highest);
    color: var(--smrt-color-primary);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-full);
    font-weight: var(--smrt-typography-weight-medium, 500);
    transition: background 0.2s;
  }
  .smrt-image-editor__tool :global(.smrt-image-editor__tonal-button:hover:not(:disabled)) {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-image-editor__tool :global(.smrt-image-editor__text-button) {
    text-decoration: underline;
  }
  .smrt-image-editor__tool :global(.smrt-image-editor__text-button:hover) {
    color: var(--smrt-color-on-surface);
  }
  .smrt-image-editor__tool :global(.smrt-image-editor__primary-button) {
    border-radius: var(--smrt-radius-full);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-image-editor__tool :global(.smrt-image-editor__primary-button:hover:not(:disabled)) {
    filter: brightness(1.1);
  }
  .smrt-image-editor__hint {
    font-size: var(--smrt-typography-body-small-size, 0.8rem);
    color: var(--smrt-color-outline);
  }
  .smrt-image-editor__error {
    color: var(--smrt-color-error);
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    border-radius: var(--smrt-radius-sm);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }
  .smrt-image-editor__success {
    color: var(--smrt-color-success);
    background: color-mix(in srgb, var(--smrt-color-success) 10%, transparent);
    border-radius: var(--smrt-radius-sm);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }
}

</style>
