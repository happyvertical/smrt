import type { ImageLike } from '@happyvertical/smrt-images/svelte';
import { joinApiUrl, normalizeApiBaseUrl } from './api.js';
import type { ContentEditorAsset } from './content-editor-form.js';

export function getContentEditorAssetImageSource(
  asset: ContentEditorAsset | Record<string, unknown>,
): string {
  return String(
    asset?.sourceUri ||
      asset?.thumbnailUri ||
      asset?.thumbnailUrl ||
      asset?.deliveryUrl ||
      asset?.url ||
      asset?.src ||
      '',
  );
}

export function readContentEditorFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target?.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function createContentEditorImageRecord(
  apiBaseUrl: string,
  input: {
    name: string;
    sourceUri: string;
    mimeType: string;
  },
): Promise<ContentEditorAsset | null> {
  const response = await fetch(
    joinApiUrl(normalizeApiBaseUrl(apiBaseUrl), '/images'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = await response.json();
  return (payload?.data ?? payload) as ContentEditorAsset | null;
}

export async function resolveContentEditorImageSelection(
  apiBaseUrl: string,
  selected: ImageLike | File | string,
): Promise<ContentEditorAsset | null> {
  if (selected && typeof selected === 'object' && 'id' in selected) {
    return selected as ContentEditorAsset;
  }

  if (selected instanceof File) {
    return createContentEditorImageRecord(apiBaseUrl, {
      name: selected.name || 'Uploaded Image',
      sourceUri: await readContentEditorFileAsDataUrl(selected),
      mimeType: selected.type || 'image/png',
    });
  }

  if (typeof selected === 'string') {
    const parsedUrl = new URL(selected);
    return createContentEditorImageRecord(apiBaseUrl, {
      name: parsedUrl.pathname.split('/').pop() || 'External Image',
      sourceUri: selected,
      mimeType: 'image/jpeg',
    });
  }

  return null;
}
