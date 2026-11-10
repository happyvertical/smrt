<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import type {
  ImageEditorClient,
  ImageLike,
  ImagesGalleryClient,
} from '../image-clients.js';
import { AssetsGallery, ImageEditor, ImageUploader } from '../index.js';

const { t } = useI18n();

let {
  apiBaseUrl = '/api/v1',
  galleryClient = undefined,
  editorClient = undefined,
  initialImage = null,
}: {
  apiBaseUrl?: string;
  galleryClient?: ImagesGalleryClient;
  editorClient?: ImageEditorClient;
  initialImage?: ImageLike | null;
} = $props();

type StudioImage = ImageLike;

let selectedImage = $state<StudioImage | null>(null);
let lastInitialImageId = $state<string | null>(null);
let uploaderStatus = $state('No image selected from the uploader yet.');

$effect(() => {
  const nextInitialImageId = initialImage?.id || null;

  if (nextInitialImageId === lastInitialImageId) {
    return;
  }

  lastInitialImageId = nextInitialImageId;
  selectedImage = initialImage;

  if (initialImage) {
    uploaderStatus = `Loaded “${initialImage.name}” from the workbench fixture.`;
  }
});

function isPersistedImage(value: unknown): value is StudioImage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'name' in value
  );
}

function handleUploaderSelect(value: StudioImage | File | string) {
  if (isPersistedImage(value)) {
    selectedImage = value;
    uploaderStatus = `Ready to edit “${value.name}”.`;
    return;
  }

  if (value instanceof File) {
    uploaderStatus = `Selected local file “${value.name}”. Persist it through your app flow before opening advanced edits.`;
    return;
  }

  uploaderStatus = `Selected external image source: ${value}`;
}

function handleGallerySelect(image: StudioImage) {
  selectedImage = image;
  uploaderStatus = `Loaded “${image.name}” from the gallery.`;
}

function handleEditorSave(image: StudioImage) {
  selectedImage = image;
  uploaderStatus = `Saved a new derivative for “${image.name}”.`;
}
</script>

<div class="smrt-image-studio-route__root" data-smrt-component="ImageStudioRoute">
  <header class="smrt-image-studio-route__header" data-smrt-part="header">
    <div>
      <p class="smrt-image-studio-route__eyebrow" data-smrt-part="label">{t(M['images.image_studio_route.eyebrow'])}</p>
      <h1>{t(M['images.image_studio_route.title'])}</h1>
      <p class="smrt-image-studio-route__lede" data-smrt-part="summary">
        {t(M['images.image_studio_route.lede'])}
      </p>
    </div>
  </header>

  <section class="smrt-image-studio-route__uploader" data-smrt-part="group">
    <div class="smrt-image-studio-route__section-copy" data-smrt-part="content">
      <h2>{t(M['images.image_studio_route.acquire_images'])}</h2>
      <p>
        {t(M['images.image_studio_route.acquire_images_description'])}
      </p>
      <p class="smrt-image-studio-route__status" data-smrt-part="status">{uploaderStatus}</p>
    </div>

    <div class="smrt-image-studio-route__card" data-smrt-part="panel">
      <ImageUploader
        {apiBaseUrl}
        {galleryClient}
        {editorClient}
        onSelect={handleUploaderSelect}
      />
    </div>
  </section>

  <section class="smrt-image-studio-route__workspace" data-smrt-part="group">
    <div class="smrt-image-studio-route__section-copy" data-smrt-part="content">
      <h2>{t(M['images.image_studio_route.browse_and_edit'])}</h2>
      <p>
        {t(M['images.image_studio_route.browse_and_edit_description'])}
      </p>
    </div>

    <div class="smrt-image-studio-route__workspace-grid" data-smrt-part="content">
      <div class="smrt-image-studio-route__card smrt-image-studio-route__gallery" data-smrt-part="panel">
        <AssetsGallery
          {apiBaseUrl}
          client={galleryClient}
          onSelect={handleGallerySelect}
        />
      </div>

      <div class="smrt-image-studio-route__card smrt-image-studio-route__editor" data-smrt-part="panel">
        <ImageEditor
          {apiBaseUrl}
          client={editorClient}
          image={selectedImage}
          onSave={handleEditorSave}
        />
      </div>
    </div>
  </section>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-image-studio-route__root {
    max-width: 1440px;
    margin: 0 auto;
    padding: 2rem;
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
    min-height: 100vh;
  }
  .smrt-image-studio-route__eyebrow {
    margin: 0 0 0.5rem;
  }
  .smrt-image-studio-route__header h1,
  .smrt-image-studio-route__section-copy h2 {
    margin: 0;
  }
  .smrt-image-studio-route__lede,
  .smrt-image-studio-route__section-copy p {
    margin: 0.75rem 0 0;
    max-width: 60rem;
  }
  .smrt-image-studio-route__uploader,
  .smrt-image-studio-route__workspace {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .smrt-image-studio-route__status {
    margin-top: 1rem;
    padding: 0.875rem 1rem;
  }
  .smrt-image-studio-route__workspace-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
  }
  .smrt-image-studio-route__card {
    overflow: hidden;
  }
  .smrt-image-studio-route__gallery {
    min-height: 720px;
  }
  .smrt-image-studio-route__editor {
    min-height: 720px;
  }
  @media (max-width: 1024px) {
    .smrt-image-studio-route__root {
      padding: 1.25rem;
    }
    .smrt-image-studio-route__workspace-grid {
      grid-template-columns: 1fr;
    }
    .smrt-image-studio-route__gallery,
    .smrt-image-studio-route__editor {
      min-height: 560px;
    }
  }
}

@layer smrt.theme {
  .smrt-image-studio-route__root {
    color: var(--smrt-color-on-surface);
    background:
      radial-gradient(circle at top, color-mix(in srgb, var(--smrt-color-primary) 22%, transparent), transparent 40%),
      var(--smrt-color-background);
  }
  .smrt-image-studio-route__eyebrow {
    color: var(--smrt-color-primary);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.08em);
    text-transform: uppercase;
  }
  .smrt-image-studio-route__header h1 {
    font-size: clamp(2rem, 3vw, 2.8rem);
  }
  .smrt-image-studio-route__lede,
  .smrt-image-studio-route__section-copy p {
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.6;
  }
  .smrt-image-studio-route__status {
    border-radius: 0.85rem;
    background: color-mix(in srgb, var(--smrt-color-surface-container) 72%, transparent);
    border: 1px solid color-mix(in srgb, var(--smrt-color-primary) 20%, transparent);
    color: var(--smrt-color-on-surface);
  }
  .smrt-image-studio-route__card {
    border-radius: 1rem;
    border: 1px solid color-mix(in srgb, var(--smrt-color-outline-variant) 18%, transparent);
    background: color-mix(in srgb, var(--smrt-color-surface-container) 72%, transparent);
    box-shadow: var(--smrt-elevation-5, 0 24px 60px color-mix(in srgb, var(--smrt-color-shadow) 35%, transparent));
  }
}

</style>
