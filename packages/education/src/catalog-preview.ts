import type { CatalogActor, CatalogSourceRecord } from './catalog-contracts.js';
import { CatalogPolicy } from './catalog-policy.js';

/** Publisher preview permission is independent of original-resource permissions. */
export interface CatalogPreview {
  providerId: 'illustrative-mathematics';
  stableId: string;
  revision: string;
  /** Official publisher ImageFile identifier, never a caller-supplied URL. */
  reference: string;
  mediaType: 'image/png';
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  alt: string;
  rights: {
    state: 'verified';
    identifier: 'CC-BY-4.0';
    sourceUrl: string;
    attribution: string;
    retrievedAt: string;
    expiresAt?: string;
  };
}

export const CATALOG_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const CATALOG_PREVIEW_MAX_DIMENSION = 4096;

/** Parse persisted/untrusted optional metadata. Invalid metadata is unavailable. */
export function normalizeCatalogPreview(
  value: unknown,
): CatalogPreview | undefined {
  try {
    const x = (
      typeof value === 'string' ? JSON.parse(value) : value
    ) as CatalogPreview;
    if (
      !x ||
      x.providerId !== 'illustrative-mathematics' ||
      typeof x.stableId !== 'string' ||
      !x.stableId ||
      x.stableId.length > 1000 ||
      typeof x.revision !== 'string' ||
      !x.revision ||
      x.revision.length > 1000 ||
      typeof x.reference !== 'string' ||
      !/^[a-zA-Z0-9]{20,64}$/.test(x.reference) ||
      x.mediaType !== 'image/png' ||
      !Number.isSafeInteger(x.byteLength) ||
      x.byteLength < 24 ||
      x.byteLength > CATALOG_PREVIEW_MAX_BYTES ||
      ![x.width, x.height].every(
        (n) =>
          Number.isSafeInteger(n) &&
          n > 0 &&
          n <= CATALOG_PREVIEW_MAX_DIMENSION,
      ) ||
      typeof x.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(x.sha256) ||
      typeof x.alt !== 'string' ||
      !x.alt ||
      x.alt.length > 2000 ||
      x.rights?.state !== 'verified' ||
      x.rights.identifier !== 'CC-BY-4.0' ||
      typeof x.rights.attribution !== 'string' ||
      !x.rights.attribution ||
      x.rights.attribution.length > 4000 ||
      typeof x.rights.sourceUrl !== 'string' ||
      typeof x.rights.retrievedAt !== 'string' ||
      !Number.isFinite(Date.parse(x.rights.retrievedAt)) ||
      (x.rights.expiresAt !== undefined &&
        (typeof x.rights.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(x.rights.expiresAt))))
    )
      return undefined;
    const source = new URL(x.rights.sourceUrl);
    if (
      source.origin !== 'https://im.kendallhunt.com' ||
      source.search ||
      source.hash ||
      source.username ||
      source.password ||
      !/^\/k5(?:_es)?\/families\/(kindergarten|grade-[1-5])\/unit-[1-9][0-9]?\/family-materials\.html$/.test(
        source.pathname,
      )
    )
      return undefined;
    // Explicit projection prevents unknown fields (including URLs/tokens) escaping.
    return {
      providerId: x.providerId,
      stableId: x.stableId,
      revision: x.revision,
      reference: x.reference,
      mediaType: x.mediaType,
      width: x.width,
      height: x.height,
      byteLength: x.byteLength,
      sha256: x.sha256,
      alt: x.alt,
      rights: {
        state: 'verified',
        identifier: 'CC-BY-4.0',
        sourceUrl: source.href,
        attribution: x.rights.attribution,
        retrievedAt: x.rights.retrievedAt,
        ...(x.rights.expiresAt ? { expiresAt: x.rights.expiresAt } : {}),
      },
    };
  } catch {
    return undefined;
  }
}

/** Exact source/revision binding; expired or corrupt references are unavailable. */
export function catalogPreviewFor(
  record: Pick<
    CatalogSourceRecord,
    'providerId' | 'stableId' | 'revision' | 'preview'
  >,
  now = Date.now(),
): CatalogPreview | undefined {
  const preview = normalizeCatalogPreview(record.preview);
  return preview &&
    preview.providerId === record.providerId &&
    preview.stableId === record.stableId &&
    preview.revision === record.revision &&
    (!preview.rights.expiresAt || Date.parse(preview.rights.expiresAt) > now)
    ? preview
    : undefined;
}

/** PNG signature and IHDR dimensions, without decoding or transforming originals. */
export function catalogPreviewPngDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  if (
    bytes.length < 24 ||
    bytes.length > CATALOG_PREVIEW_MAX_BYTES ||
    ![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].every(
      (n, i) => bytes[i] === n,
    )
  )
    throw new Error('Invalid catalog preview PNG.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (
    ![width, height].every((n) => n > 0 && n <= CATALOG_PREVIEW_MAX_DIMENSION)
  )
    throw new Error('Catalog preview dimensions exceed bounds.');
  return { width, height };
}

export interface CatalogPreviewStore {
  /** Must read through the active actor/tenant-bound executor, never a global write bypass. */
  getResource(
    id: string,
    actor: CatalogActor,
  ): Promise<
    | (CatalogSourceRecord & { id: string; withdrawnAt?: string | null })
    | undefined
  >;
  /** Recheck live session, tenant membership and resource access on EVERY read, including cache hits. */
  authorize(
    actor: CatalogActor,
    resource: CatalogSourceRecord & { id: string },
  ): Promise<boolean>;
}
export interface CatalogPreviewLoader {
  /** Preview-only bytes, bounded by CATALOG_PREVIEW_MAX_BYTES; never acquire the original. */
  loadPreview(preview: CatalogPreview): Promise<Uint8Array>;
}

/** Authorized serving of public publisher previews with a bounded, short-lived verified-byte cache. */
export class CatalogPreviewService {
  private readonly cache = new Map<
    string,
    { bytes: Uint8Array; until: number }
  >();
  private cacheBytes = 0;
  constructor(
    private readonly store: CatalogPreviewStore,
    private readonly loader: CatalogPreviewLoader,
  ) {}

  async serve(input: {
    actor: CatalogActor;
    resourceId: string;
    revision: string;
  }): Promise<Response> {
    const unavailable = () =>
      new Response(null, {
        status: 404,
        headers: { 'cache-control': 'no-store' },
      });
    const { actor } = input;
    if (!actor.tenantId?.trim() || !actor.actorUserId?.trim())
      return unavailable();
    const record = await this.store.getResource(input.resourceId, actor);
    if (
      !record ||
      record.id !== input.resourceId ||
      record.withdrawnAt ||
      record.revision !== input.revision ||
      !new CatalogPolicy().canView(record, actor) ||
      (await this.store.authorize(actor, record)) !== true
    )
      return unavailable();
    const preview = catalogPreviewFor(record);
    if (!preview) return unavailable();
    const key = preview.sha256;
    const now = Date.now();
    for (const [id, entry] of this.cache)
      if (entry.until <= now) {
        this.cache.delete(id);
        this.cacheBytes -= entry.bytes.length;
      }
    let bytes = this.cache.get(key)?.bytes;
    if (!bytes) {
      try {
        bytes = await this.loader.loadPreview(preview);
        const dimensions = catalogPreviewPngDimensions(bytes);
        const hash = Buffer.from(
          await globalThis.crypto.subtle.digest(
            'SHA-256',
            Uint8Array.from(bytes),
          ),
        ).toString('hex');
        if (
          bytes.length !== preview.byteLength ||
          dimensions.width !== preview.width ||
          dimensions.height !== preview.height ||
          hash !== preview.sha256
        )
          return unavailable();
        bytes = Uint8Array.from(bytes);
        while (this.cacheBytes + bytes.length > 16 * 1024 * 1024) {
          const first = this.cache.entries().next().value;
          if (!first) break;
          this.cache.delete(first[0]);
          this.cacheBytes -= first[1].bytes.length;
        }
        this.cache.set(key, {
          bytes,
          until: Math.min(
            now + 60_000,
            preview.rights.expiresAt
              ? Date.parse(preview.rights.expiresAt)
              : Infinity,
          ),
        });
        this.cacheBytes += bytes.length;
      } catch {
        return unavailable();
      }
    }
    const dimensions = catalogPreviewPngDimensions(bytes);
    if (
      bytes.length !== preview.byteLength ||
      dimensions.width !== preview.width ||
      dimensions.height !== preview.height
    )
      return unavailable();
    return new Response(Uint8Array.from(bytes), {
      headers: {
        'content-type': 'image/png',
        'content-length': String(bytes.length),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  }
}
