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

export function getContentEditorMimeTypeFromPath(pathname: string): string {
  const extension = pathname.split('.').pop()?.toLowerCase() ?? '';
  switch (extension) {
    case 'avif':
      return 'image/avif';
    case 'gif':
      return 'image/gif';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function getMimeTypeFromUrl(parsedUrl: URL): string {
  if (parsedUrl.protocol === 'data:') {
    const [, mimeType] = parsedUrl.href.match(/^data:([^;,]+)/) ?? [];
    return mimeType || 'application/octet-stream';
  }

  return getContentEditorMimeTypeFromPath(parsedUrl.pathname);
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
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(selected);
    } catch {
      return null;
    }

    return createContentEditorImageRecord(apiBaseUrl, {
      name: parsedUrl.pathname.split('/').pop() || 'External Image',
      sourceUri: selected,
      mimeType: getMimeTypeFromUrl(parsedUrl),
    });
  }

  return null;
}

/** Natural pixel size of an image, as used to choose a thumbnail placement. */
export interface ContentEditorImageDimensions {
  width: number;
  height: number;
}

function positiveDimension(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * The size of an attached image: from the asset's own `width`/`height` (or
 * `metadata.width`/`metadata.height`) when recorded, otherwise by loading
 * `src` in the browser. Resolves `null` when neither is available (no DOM,
 * load error, or `timeoutMs` elapsed).
 */
export async function resolveContentEditorImageDimensions(
  asset: Record<string, unknown> | null | undefined,
  src: string,
  options: { timeoutMs?: number } = {},
): Promise<ContentEditorImageDimensions | null> {
  const metadata =
    asset?.metadata && typeof asset.metadata === 'object'
      ? (asset.metadata as Record<string, unknown>)
      : {};
  const width = positiveDimension(asset?.width ?? metadata.width);
  const height = positiveDimension(asset?.height ?? metadata.height);
  if (width && height) {
    return { width, height };
  }

  const ImageConstructor = (globalThis as { Image?: typeof Image }).Image;
  if (!src || typeof ImageConstructor !== 'function') {
    return null;
  }

  return new Promise((resolve) => {
    const image = new ImageConstructor();
    const timer = setTimeout(() => resolve(null), options.timeoutMs ?? 8000);
    image.onload = () => {
      clearTimeout(timer);
      const naturalWidth = positiveDimension(image.naturalWidth);
      const naturalHeight = positiveDimension(image.naturalHeight);
      resolve(
        naturalWidth && naturalHeight
          ? { width: naturalWidth, height: naturalHeight }
          : null,
      );
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    image.src = src;
  });
}
