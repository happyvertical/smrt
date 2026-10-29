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

/** Verify complete bounded static 8-bit RGB/RGBA PNG data; never transform originals. */
export function catalogPreviewPngDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  // Like core's manifest Node host, resolve built-ins only when the server
  // capability is invoked; metadata/model imports must remain browser-safe.
  const host = (
    typeof process === 'undefined'
      ? undefined
      : process.getBuiltinModule?.('node:zlib')
  ) as typeof import('node:zlib') | undefined;
  if (!host)
    throw new Error('Catalog preview verification requires a Node host.');
  const { crc32, inflateSync } = host;
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
  // Keep the supported subset explicit. Other encodings remain unavailable.
  const channels = bytes[25] === 2 ? 3 : bytes[25] === 6 ? 4 : 0;
  if (
    bytes.length < 45 ||
    bytes[24] !== 8 ||
    !channels ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[28] !== 0
  )
    throw new Error('Unsupported catalog preview PNG encoding.');
  const compressed: Uint8Array[] = [];
  let offset = 8;
  let ended = false;
  let idatEnded = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12)
      throw new Error('Truncated catalog preview PNG chunk.');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (
      !/^[a-zA-Z]{2}[A-Z][a-zA-Z]$/.test(type) ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)
    )
      throw new Error('Invalid catalog preview PNG chunk.');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13)
        throw new Error('Invalid catalog preview PNG header.');
    } else if (type === 'IDAT') {
      if (idatEnded)
        throw new Error('Invalid catalog preview PNG image ordering.');
      compressed.push(bytes.subarray(offset + 8, end - 4));
    } else {
      if (compressed.length) idatEnded = true;
      if (type === 'IEND') {
        if (length || end !== bytes.length)
          throw new Error('Invalid catalog preview PNG ending.');
        ended = true;
      } else if (type === 'PLTE') {
        if (compressed.length || !length || length > 768 || length % 3)
          throw new Error('Invalid catalog preview PNG palette.');
      } else if (/^[A-Z]/.test(type) || ['acTL', 'fcTL', 'fdAT'].includes(type))
        throw new Error('Unsupported catalog preview PNG chunk.');
    }
    offset = end;
  }
  if (!ended || offset !== bytes.length || !compressed.length)
    throw new Error('Incomplete catalog preview PNG.');
  const stride = width * channels + 1;
  const raw = inflateSync(Buffer.concat(compressed), {
    maxOutputLength: stride * height,
  });
  if (raw.length !== stride * height)
    throw new Error('Invalid catalog preview PNG pixel data.');
  for (let row = 0; row < height; row++)
    if (raw[row * stride] > 4)
      throw new Error('Invalid catalog preview PNG filter.');
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
    { bytes: Uint8Array; until: number; width: number; height: number }
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
    const cached = this.cache.get(key);
    if (
      cached &&
      (cached.bytes.length !== preview.byteLength ||
        cached.width !== preview.width ||
        cached.height !== preview.height)
    )
      return unavailable();
    let bytes = cached?.bytes;
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
        if (!catalogPreviewFor(record)) return unavailable();
        bytes = Uint8Array.from(bytes);
        // Another miss may have populated this key while loading/hash-checking.
        const replaced = this.cache.get(key);
        if (replaced) {
          this.cache.delete(key);
          this.cacheBytes -= replaced.bytes.length;
        }
        while (this.cacheBytes + bytes.length > 16 * 1024 * 1024) {
          const first = this.cache.entries().next().value;
          if (!first) break;
          this.cache.delete(first[0]);
          this.cacheBytes -= first[1].bytes.length;
        }
        this.cache.set(key, {
          bytes,
          ...dimensions,
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
    if (!catalogPreviewFor(record)) return unavailable();
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
