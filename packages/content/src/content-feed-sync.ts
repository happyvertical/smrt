import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  ObjectRegistry,
  type SmrtCollectionOptions,
} from '@happyvertical/smrt-core';
import {
  type ParsedContentFeedItem,
  parseContentFeed,
} from './content-feed-parser';
import type { ContentFeedSource } from './content-feed-source';
import { Mirror } from './content-types';
import { Contents } from './contents';

export interface ContentFeedSyncOptions extends SmrtCollectionOptions {
  fetch?: typeof fetch;
  maxItems?: number;
  maxResponseBytes?: number;
  fetchTimeoutMs?: number;
  allowPrivateNetworkHosts?: boolean;
  resolveHostname?: typeof resolveHostname;
  status?: 'published' | 'draft';
  now?: () => Date;
}

export interface ContentFeedSyncResult {
  source: ContentFeedSource;
  fetched: boolean;
  notModified: boolean;
  imported: number;
  updated: number;
  skipped: number;
}

type QueryableCollection = Pick<Contents, 'query'>;
type ResolvedAddress = { address: string; family?: number };

const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const FALLBACK_MIRROR_META_TYPE = '@happyvertical/smrt-content:Mirror';

async function resolveHostname(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: false });
}

function getMirrorMetaType(): string {
  return (
    ObjectRegistry.getClassByConstructor(Mirror)?.qualifiedName ??
    FALLBACK_MIRROR_META_TYPE
  );
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'feed';
}

function normalizeUrlIdentity(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.trim();
  }
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function createDedupeKey(
  source: ContentFeedSource,
  item: ParsedContentFeedItem,
): string {
  return `feed:${source.id ?? source.feedUrl}:${item.guid || normalizeUrlIdentity(item.url)}`;
}

function isBlockedIPv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return true;
  }

  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

function isBlockedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff')
  );
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true;
}

async function validateFeedFetchUrl(
  feedUrl: string,
  options: ContentFeedSyncOptions,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(feedUrl);
  } catch {
    throw new Error('Feed URL must be an absolute URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Feed URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('Feed URL must not include credentials');
  }
  if (!url.hostname) {
    throw new Error('Feed URL must include a hostname');
  }

  if (options.allowPrivateNetworkHosts) return url;

  const addresses =
    isIP(url.hostname) === 0
      ? await (options.resolveHostname ?? resolveHostname)(url.hostname)
      : [{ address: url.hostname }];

  if (
    !addresses.length ||
    addresses.some(({ address }) => isBlockedAddress(address))
  ) {
    throw new Error('Feed URL must resolve to a public network address');
  }

  return url;
}

function createTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (timeoutMs <= 0) return undefined;
  return AbortSignal.timeout(timeoutMs);
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Feed response exceeds ${maxBytes} bytes`);
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`Feed response exceeds ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`Feed response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(buffer);
}

async function findExistingMirror(
  contents: QueryableCollection,
  source: ContentFeedSource,
  item: ParsedContentFeedItem,
  dedupeKey: string,
): Promise<{ id: string; status: string | null } | null> {
  const tenantWhere = source.tenantId ? 'tenant_id = ?' : 'tenant_id IS NULL';
  const params: unknown[] = [getMirrorMetaType()];
  if (source.tenantId) params.push(source.tenantId);

  if (item.guid) {
    const result = await contents.query(
      `SELECT id, status
         FROM contents
        WHERE _meta_type = ?
          AND ${tenantWhere}
          AND feed_source_id = ?
          AND source_guid = ?
        LIMIT 1`,
      [...params, source.id, item.guid],
    );
    if (result[0]) return result[0] as { id: string; status: string | null };
  }

  const result = await contents.query(
    `SELECT id, status
       FROM contents
      WHERE _meta_type = ?
        AND ${tenantWhere}
        AND feed_source_id = ?
        AND dedupe_key = ?
      LIMIT 1`,
    [...params, source.id, dedupeKey],
  );
  return (
    (result[0] as { id: string; status: string | null } | undefined) ?? null
  );
}

async function upsertMirrorItem(
  contents: QueryableCollection,
  source: ContentFeedSource,
  item: ParsedContentFeedItem,
  status: 'published' | 'draft',
  now: Date,
): Promise<'imported' | 'updated'> {
  const dedupeKey = createDedupeKey(source, item);
  const existing = await findExistingMirror(contents, source, item, dedupeKey);
  const publishedAt = (item.publishedAt ?? item.updatedAt ?? now).toISOString();
  const sourceSlug = slugify(
    source.sourceGroup || source.name || source.feedUrl,
  );
  const category = source.defaultCategory || item.categories[0] || null;
  const tags = JSON.stringify(item.categories);

  if (existing) {
    await contents.query(
      `UPDATE contents
          SET title = ?,
              name = ?,
              description = ?,
              source = ?,
              original_url = ?,
              url = ?,
              feed_source_id = ?,
              source_guid = ?,
              source_name = ?,
              source_homepage_url = ?,
              external_url = ?,
              original_published_at = ?,
              dedupe_key = ?,
              publish_date = ?,
              author = ?,
              category = ?,
              tags = ?,
              status = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        item.title,
        item.title,
        item.summary,
        source.name,
        item.url,
        item.url,
        source.id,
        item.guid,
        source.name,
        source.homepageUrl,
        item.url,
        publishedAt,
        dedupeKey,
        publishedAt,
        item.author,
        category,
        tags,
        existing.status || status,
        now.toISOString(),
        existing.id,
      ],
    );
    return 'updated';
  }

  const id = randomUUID();
  await contents.query(
    `INSERT INTO contents (
       id, slug, context, _meta_type, title, name, description, body,
       status, state, metadata, source, original_url, url, feed_source_id,
       source_guid, source_name, source_homepage_url, external_url,
       original_published_at, dedupe_key, tenant_id, publish_date, author,
       category, tags, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `mirror-${sourceSlug}-${hashString(dedupeKey)}`,
      '',
      getMirrorMetaType(),
      item.title,
      item.title,
      item.summary,
      '',
      status,
      'active',
      '{}',
      source.name,
      item.url,
      item.url,
      source.id,
      item.guid,
      source.name,
      source.homepageUrl,
      item.url,
      publishedAt,
      dedupeKey,
      source.tenantId,
      publishedAt,
      item.author,
      category,
      tags,
      now.toISOString(),
      now.toISOString(),
    ],
  );
  return 'imported';
}

export async function syncContentFeedSource(
  source: ContentFeedSource,
  options: ContentFeedSyncOptions = {},
): Promise<ContentFeedSyncResult> {
  if (source.status === 'paused' || source.status === 'archived') {
    return {
      source,
      fetched: false,
      notModified: false,
      imported: 0,
      updated: 0,
      skipped: 0,
    };
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('No fetch implementation available');

  const headers: Record<string, string> = {
    Accept:
      'application/rss+xml, application/atom+xml, application/xml, text/xml',
    'User-Agent': '@happyvertical/smrt-content feed sync',
  };
  if (source.etag) headers['If-None-Match'] = source.etag;
  if (source.lastModified) headers['If-Modified-Since'] = source.lastModified;

  const now = options.now?.() ?? new Date();
  source.markFetchStarted(now);
  await source.save();

  try {
    const feedUrl = await validateFeedFetchUrl(source.feedUrl, options);
    const response = await fetchImpl(feedUrl, {
      headers,
      signal: createTimeoutSignal(
        options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      ),
    });

    if (response.status === 304) {
      source.markFetchSucceeded(now);
      await source.save();
      return {
        source,
        fetched: true,
        notModified: true,
        imported: 0,
        updated: 0,
        skipped: 0,
      };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const parsed = parseContentFeed(
      await readResponseText(
        response,
        options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      ),
      feedUrl.toString(),
    );
    source.format = parsed.format;
    source.homepageUrl = source.homepageUrl || parsed.homepageUrl;
    if (!source.name && parsed.title) source.name = parsed.title;

    const contents = await Contents.create(options);
    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const item of parsed.items.slice(0, options.maxItems)) {
      try {
        const result = await upsertMirrorItem(
          contents,
          source,
          item,
          options.status ?? 'published',
          now,
        );
        if (result === 'imported') imported += 1;
        else updated += 1;
      } catch {
        skipped += 1;
      }
    }

    source.markFetchSucceeded(now, {
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    });
    await source.save();

    return {
      source,
      fetched: true,
      notModified: false,
      imported,
      updated,
      skipped,
    };
  } catch (error) {
    source.markFetchFailed(error, now);
    await source.save();
    throw error;
  }
}
