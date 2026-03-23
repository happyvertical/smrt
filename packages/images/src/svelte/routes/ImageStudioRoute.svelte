<script lang="ts">
import type { ImageLike } from '../image-clients.js';
import { AssetsGallery, ImageEditor, ImageUploader } from '../index.js';

let { apiBaseUrl = '/api/v1' }: { apiBaseUrl?: string } = $props();

type StudioImage = ImageLike;

let selectedImage = $state<StudioImage | null>(null);
let uploaderStatus = $state('No image selected from the uploader yet.');

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

<div class="images-route">
  <header class="images-route__header">
    <div>
      <p class="images-route__eyebrow">Package Route Surface</p>
      <h1>Image Studio</h1>
      <p class="images-route__lede">
        A package-owned route for acquiring images, browsing stored assets, and
        moving directly into the editor workflow.
      </p>
    </div>
  </header>

  <section class="images-route__uploader">
    <div class="images-route__section-copy">
      <h2>Acquire Images</h2>
      <p>
        Use the uploader to test gallery selection, local uploads, camera
        capture, and external URLs from the same package surface downstream apps
        can mount.
      </p>
      <p class="images-route__status">{uploaderStatus}</p>
    </div>

    <div class="images-route__card">
      <ImageUploader {apiBaseUrl} onSelect={handleUploaderSelect} />
    </div>
  </section>

  <section class="images-route__workspace">
    <div class="images-route__section-copy">
      <h2>Browse And Edit</h2>
      <p>
        The gallery and editor stay wired together so route consumers can see
        the intended package flow instead of disconnected component snapshots.
      </p>
    </div>

    <div class="images-route__workspace-grid">
      <div class="images-route__card images-route__gallery">
        <AssetsGallery {apiBaseUrl} onSelect={handleGallerySelect} />
      </div>

      <div class="images-route__card images-route__editor">
        <ImageEditor
          {apiBaseUrl}
          image={selectedImage}
          onSave={handleEditorSave}
        />
      </div>
    </div>
  </section>
</div>

<style>
  .images-route {
    max-width: 1440px;
    margin: 0 auto;
    padding: 2rem;
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
    color: #e2e8f0;
    background:
      radial-gradient(circle at top, rgba(37, 99, 235, 0.22), transparent 40%),
      #020617;
    min-height: 100vh;
  }

  .images-route__eyebrow {
    margin: 0 0 0.5rem;
    color: #7dd3fc;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .images-route__header h1,
  .images-route__section-copy h2 {
    margin: 0;
  }

  .images-route__header h1 {
    font-size: clamp(2rem, 3vw, 2.8rem);
  }

  .images-route__lede,
  .images-route__section-copy p {
    margin: 0.75rem 0 0;
    color: #cbd5e1;
    line-height: 1.6;
    max-width: 60rem;
  }

  .images-route__uploader,
  .images-route__workspace {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .images-route__status {
    margin-top: 1rem;
    padding: 0.875rem 1rem;
    border-radius: 0.85rem;
    background: rgba(15, 23, 42, 0.72);
    border: 1px solid rgba(125, 211, 252, 0.2);
    color: #e0f2fe;
  }

  .images-route__workspace-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
  }

  .images-route__card {
    border-radius: 1rem;
    border: 1px solid rgba(148, 163, 184, 0.18);
    background: rgba(15, 23, 42, 0.72);
    box-shadow: 0 24px 60px rgba(2, 6, 23, 0.35);
    overflow: hidden;
  }

  .images-route__gallery {
    min-height: 720px;
  }

  .images-route__editor {
    min-height: 720px;
  }

  @media (max-width: 1024px) {
    .images-route {
      padding: 1.25rem;
    }

    .images-route__workspace-grid {
      grid-template-columns: 1fr;
    }

    .images-route__gallery,
    .images-route__editor {
      min-height: 560px;
    }
  }
</style>
