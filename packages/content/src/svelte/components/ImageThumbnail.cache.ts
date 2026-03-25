export type ThumbnailState = 'loading' | 'ready' | 'missing';

type ThumbnailCacheEntry = {
  state: ThumbnailState;
  url: string | null;
  expiresAt: number | null;
};

const THUMBNAIL_CACHE_MAX_ENTRIES = 200;
export const THUMBNAIL_FAILURE_TTL_MS = 30_000;

const thumbnailCache = new Map<string, ThumbnailCacheEntry>();

export function clearThumbnailCache(): void {
  thumbnailCache.clear();
}

export function getCachedThumbnail(
  cacheKey: string,
): ThumbnailCacheEntry | undefined {
  const cached = thumbnailCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }

  if (cached.expiresAt !== null && cached.expiresAt <= Date.now()) {
    thumbnailCache.delete(cacheKey);
    return undefined;
  }

  thumbnailCache.delete(cacheKey);
  thumbnailCache.set(cacheKey, cached);
  return cached;
}

export function setCachedThumbnail(
  cacheKey: string,
  entry: Omit<ThumbnailCacheEntry, 'expiresAt'> & {
    expiresAt?: number | null;
  },
): void {
  if (thumbnailCache.has(cacheKey)) {
    thumbnailCache.delete(cacheKey);
  }

  thumbnailCache.set(cacheKey, {
    state: entry.state,
    url: entry.url,
    expiresAt: entry.expiresAt ?? null,
  });

  while (thumbnailCache.size > THUMBNAIL_CACHE_MAX_ENTRIES) {
    const oldestKey = thumbnailCache.keys().next().value;
    if (!oldestKey) {
      break;
    }

    thumbnailCache.delete(oldestKey);
  }
}
