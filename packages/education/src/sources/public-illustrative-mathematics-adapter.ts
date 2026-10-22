import { normalizeCatalogRepresentation } from '../catalog-capability.js';
import type {
  CatalogAcquireAdapter,
  CatalogSourceRecord,
  CatalogSyncAdapter,
  CatalogSyncPage,
} from '../catalog-contracts.js';
import {
  IM_ASSET_ORIGIN,
  IM_LICENSE,
  IM_ORIGIN,
  IM_ROOTS,
  imHierarchyTitle,
  imPagePath,
  imStableId,
  parseImFirstEditionPage,
} from './public-illustrative-mathematics-parser.js';

export interface PublicIllustrativeMathematicsFirstEditionConfig {
  /** Standard fetch, including streaming Response bodies; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per enumeration/acquisition total deadline. Default 20 seconds; maximum 60 seconds. */
  timeoutMs?: number;
  /** Selected PDF cap. Default 32 MiB; maximum 64 MiB. */
  maxPdfBytes?: number;
}
interface Cursor {
  v: 1;
  todo: string[];
  offset: number;
  pageRevision?: string;
}
interface Revision {
  v: 1;
  page: string;
  etag: string;
  length: number;
  modified: string;
}
const PROVIDER = 'illustrative-mathematics';
const METADATA_CAP = 2_000_000;
const HEADS_PER_PAGE = 4;
function retryDelay(value: string | null): number {
  if (!value) return 60_000;
  const delay = /^[0-9]+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay)
    ? Math.min(3_600_000, Math.max(0, delay))
    : 60_000;
}
function encode(value: unknown): string {
  return JSON.stringify(value);
}
function cursor(value?: string): Cursor {
  if (!value) return { v: 1, todo: ['/', ...IM_ROOTS], offset: 0 };
  if (value.length > 64_000) throw new Error('Cursor exceeds its size bound.');
  const x = JSON.parse(value) as Cursor;
  if (
    !x ||
    Object.keys(x).some(
      (k) => !['v', 'todo', 'offset', 'pageRevision'].includes(k),
    ) ||
    x.v !== 1 ||
    !Array.isArray(x.todo) ||
    !x.todo.length ||
    x.todo.length > 384 ||
    !Number.isSafeInteger(x.offset) ||
    x.offset < 0 ||
    x.offset > 128 ||
    (x.pageRevision !== undefined &&
      (typeof x.pageRevision !== 'string' || x.pageRevision.length > 256)) ||
    (x.offset > 0 && !x.pageRevision)
  )
    throw new Error('Invalid first-edition cursor.');
  for (const p of x.todo)
    if (typeof p !== 'string' || p.length > 160 || imPagePath(p).path !== p)
      throw new Error('Invalid cursor hierarchy path.');
  if (new Set(x.todo).size !== x.todo.length)
    throw new Error('Duplicate cursor paths.');
  return x;
}
function observedMetadata(response: Response) {
  const etag = response.headers.get('etag') ?? '';
  const lengthText = response.headers.get('content-length') ?? '';
  const length = Number(lengthText);
  const modified = response.headers.get('last-modified') ?? '';
  if (
    response.headers.has('content-encoding') &&
    response.headers.get('content-encoding') !== 'identity'
  )
    throw new Error('PDF representation is unexpectedly encoded.');
  if (
    !/^"[\x21\x23-\x7e]{1,200}"$/.test(etag) ||
    !/^[1-9][0-9]*$/.test(lengthText) ||
    !Number.isSafeInteger(length) ||
    !modified ||
    !Number.isFinite(Date.parse(modified)) ||
    modified.length > 100 ||
    !/^application\/(?:pdf|zip)(?:\s*;|$)/i.test(
      response.headers.get('content-type') ?? '',
    )
  )
    throw new Error(
      'Metadata requires a strong ETag, positive safe length, Last-Modified, and recognized PDF or ZIP content type.',
    );
  const format = /^application\/pdf(?:\s*;|$)/i.test(
    response.headers.get('content-type') ?? '',
  )
    ? 'pdf'
    : 'zip';
  return { etag, length, modified, format } as const;
}
function validators(
  response: Response,
  cap: number,
): Omit<Revision, 'v' | 'page'> {
  const { format, ...metadata } = observedMetadata(response);
  if (format !== 'pdf' || metadata.length > cap)
    throw new Error(
      'Selected representation requires PDF content type and bounded length.',
    );
  return metadata;
}
async function readBody(response: Response, cap: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > cap))
    throw new Error('Response exceeds declared body bound.');
  if (!response.body) throw new Error('Provider response body is missing.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > cap) throw new Error('Provider streamed body exceeds bound.');
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function sha256(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)),
  ]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
/**
 * Public first-edition English/linked Spanish K–12 teacher/family hierarchy.
 * Each enumeration reads one HTML page and at most four asset HEADs. Only an
 * explicit, validated selection can GET PDF bytes; generic acquisition retains
 * policy, tenant isolation, idempotence, attribution and notices.
 */
export function createPublicIllustrativeMathematicsFirstEditionAdapter(
  config: PublicIllustrativeMathematicsFirstEditionConfig = {},
): CatalogSyncAdapter & CatalogAcquireAdapter {
  const fetcher = config.fetch ?? globalThis.fetch;
  const timeout = config.timeoutMs ?? 20_000;
  const pdfCap = config.maxPdfBytes ?? 32 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 60_000 ||
    !Number.isSafeInteger(pdfCap) ||
    pdfCap < 5 ||
    pdfCap > 64 * 1024 * 1024
  )
    throw new Error('Invalid first-edition request bounds.');
  async function operation<T>(
    run: (
      request: (
        url: string,
        method: 'GET' | 'HEAD',
        headers?: Record<string, string>,
      ) => Promise<Response>,
    ) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(async (url, method, headers = {}) => {
          if (controller.signal.aborted)
            throw new Error('First-edition operation timed out.');
          const response = await fetcher(url, {
            method,
            redirect: 'error',
            signal: controller.signal,
            headers: {
              'accept-encoding': 'identity',
              accept: url.startsWith(IM_ASSET_ORIGIN)
                ? 'application/pdf'
                : 'text/html',
              ...headers,
            },
          });
          if (
            !response.ok ||
            response.status !== 200 ||
            response.redirected ||
            response.url !== url
          ) {
            await response.body?.cancel();
            const error = new Error(
              `Official provider request failed: HTTP ${response.status} or unexpected redirect.`,
            );
            Object.assign(error, {
              retryAfterMs:
                response.status === 429
                  ? retryDelay(response.headers.get('retry-after'))
                  : undefined,
            });
            throw error;
          }
          return response;
        }),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('First-edition operation timed out.'));
          }, timeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  async function html(
    request: Parameters<Parameters<typeof operation>[0]>[0],
    path: string,
  ) {
    const response = await request(IM_ORIGIN + path, 'GET');
    if (
      !/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    )
      throw new Error('Expected official HTML metadata.');
    const bytes = await readBody(response, METADATA_CAP);
    const parsed = parseImFirstEditionPage(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      path,
    );
    // Official HTML includes per-request CSRF tokens and changing weak ETags.
    // Bind the revision to the exact validated source semantics, not session markup.
    const revision = await sha256(
      new TextEncoder().encode(encode({ path, ...parsed })),
    );
    return { parsed, revision };
  }
  return {
    async enumerate(input): Promise<CatalogSyncPage> {
      let state: Cursor;
      try {
        state = cursor(input.cursor ?? input.checkpoint.cursor);
      } catch (error) {
        return {
          records: [],
          complete: false,
          paused: true,
          exclusions: [
            { code: 'invalid_provider_cursor', message: String(error) },
          ],
        };
      }
      try {
        return await operation(async (request) => {
          const path = state.todo[0];
          const { parsed, revision } = await html(request, path);
          if (state.pageRevision && state.pageRevision !== revision)
            throw new Error(
              'Metadata changed during cursor traversal; restart this sync generation.',
            );
          if (state.offset > parsed.artifacts.length)
            throw new Error('Cursor artifact offset exceeds source page.');
          const policyExclusions =
            state.offset === 0 ? [...parsed.exclusions] : [];
          const records: CatalogSourceRecord[] = [];
          const page = imPagePath(path);
          const expectsChildren =
            page.leaf === 'root' ||
            (page.audience === 'teachers' &&
              !page.lesson &&
              ['units', 'lessons', 'index'].includes(page.leaf)) ||
            (page.audience === 'families' &&
              !page.unit &&
              ['units', 'index'].includes(page.leaf));
          if (expectsChildren && !parsed.children.length)
            throw new Error(
              'Official hierarchy page has no recognized children; coverage is incomplete.',
            );
          if (page.course && state.offset === 0)
            records.push({
              providerId: PROVIDER,
              stableId: imStableId(path),
              revision,
              canonicalUrl: IM_ORIGIN + path,
              title: imHierarchyTitle(page),
              parentStableId: page.lesson
                ? imStableId(
                    path.replace(
                      /\/(?:lesson-)?[0-9]+\/preparation.html$/,
                      page.band.startsWith('k5')
                        ? '/lessons.html'
                        : '/index.html',
                    ),
                  )
                : page.unit
                  ? imStableId(
                      `/${page.band}/${page.audience}/${page.course}/${page.band.startsWith('k5') ? 'units' : 'index'}.html`,
                    )
                  : undefined,
              resourceType: page.lesson
                ? 'lesson'
                : page.unit
                  ? 'unit'
                  : 'course',
              subjects: ['mathematics'],
              language: page.band.toLowerCase().endsWith('_es') ? 'es' : 'en',
              availableFormats: ['html'],
              visibility: 'teacher',
              licenseEvidence: {
                state: parsed.licensed ? 'verified' : 'unknown',
                sourceUrl: IM_ORIGIN + path,
                permittedOperations: ['link'],
              },
            });
          const slice = parsed.artifacts.slice(
            state.offset,
            state.offset + HEADS_PER_PAGE,
          );
          const results = await Promise.allSettled(
            slice.map(async (asset) => {
              if (!asset.allowed || !parsed.licensed || !parsed.attribution) {
                policyExclusions.push({
                  code: !asset.allowed
                    ? 'teacher_or_unknown_role'
                    : 'unverified_license',
                  message: `${asset.id}: ${asset.label || 'Unknown label'}.`,
                });
                return;
              }
              const response = await request(
                `${IM_ASSET_ORIGIN}/${asset.id}`,
                'HEAD',
              );
              const { format, ...metadata } = observedMetadata(response);
              const representation = normalizeCatalogRepresentation({
                format,
                mediaType: `application/${format}`,
                byteLength: metadata.length,
                validators: {
                  etag: metadata.etag,
                  lastModified: metadata.modified,
                },
                acquisition:
                  format === 'zip'
                    ? { status: 'unsupported-format' }
                    : {
                        status:
                          metadata.length <= pdfCap
                            ? 'supported'
                            : 'size-limit',
                        maxBytes: pdfCap,
                      },
              });
              // Retain the published PDF revision encoding; capability limits are not content identity.
              const pinned =
                format === 'pdf'
                  ? { v: 1, page: revision, ...metadata }
                  : {
                      v: 2,
                      page: revision,
                      ...metadata,
                      mediaType: 'application/zip',
                    };
              const grade = page.band.startsWith('k5')
                ? page.course === 'kindergarten'
                  ? 'K'
                  : page.course?.slice(6)
                : page.band.startsWith('MS')
                  ? String(Number(page.course) + 5)
                  : undefined;
              records.push({
                providerId: PROVIDER,
                stableId: imStableId(path, asset.id),
                revision: encode(pinned),
                canonicalUrl: IM_ORIGIN + path,
                title: `${imHierarchyTitle(page)} — ${asset.label}`,
                suppliedDescription: `${parsed.title}. Source label: ${asset.label}.`,
                author: 'Illustrative Mathematics',
                subjects: ['mathematics'],
                gradeRange: grade
                  ? { min: grade, max: grade }
                  : { min: '9', max: '12' },
                language: page.band.toLowerCase().endsWith('_es') ? 'es' : 'en',
                resourceType: 'student-material',
                parentStableId: imStableId(path),
                availableFormats: [format],
                representation,
                visibility: 'catalog',
                licenseEvidence: {
                  state: 'verified',
                  identifier: 'CC BY',
                  version: '4.0',
                  sourceUrl: IM_ORIGIN + path,
                  attribution: `${parsed.attribution}\n${IM_ORIGIN + path}\n${IM_LICENSE}`,
                  exceptions: `${parsed.notices}\nOriginal first-edition ${format.toUpperCase()}; no changes made. License: ${IM_LICENSE}`,
                  retrievedAt: new Date().toISOString(),
                  permittedOperations: [
                    'link',
                    'download',
                    'print',
                    'adapt',
                    'redistribute',
                    'commercial-use',
                  ],
                },
              });
            }),
          );
          // Do not advance a cursor or emit a partial page after any failed HEAD.
          const failure = results.find((r) => r.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
          const end = state.offset + slice.length;
          const next: Cursor =
            end < parsed.artifacts.length
              ? { ...state, offset: end, pageRevision: revision }
              : {
                  v: 1,
                  todo: [...parsed.children, ...state.todo.slice(1)],
                  offset: 0,
                };
          if (next.todo.length > 384 || encode(next).length > 64_000)
            throw new Error('Hierarchy cursor exceeds its durable bound.');
          if (path === '/')
            policyExclusions.push({
              code: 'declared_scope',
              message:
                'Public first-edition PDF-labeled artifacts with observed PDF/ZIP representations explicitly labeled for students/families on official K5/MS/HS teacher/family course, unit, resources and lesson preparation pages, including linked Spanish counterparts and Algebra 1 Supports. HTML-only lessons, unknown formats, teacher/login and unknown-role material are excluded; AccessIM/v.360 is excluded.',
            });
          return {
            records: records.sort((a, b) =>
              a.stableId.localeCompare(b.stableId),
            ),
            complete: next.todo.length === 0,
            ...(next.todo.length ? { nextCursor: encode(next) } : {}),
            policyExclusions,
          };
        });
      } catch (error) {
        return {
          records: [],
          complete: false,
          paused: true,
          nextCursor: encode(state),
          exclusions: [
            {
              code: 'provider_metadata_unavailable',
              message: error instanceof Error ? error.message : String(error),
              retryAfterMs: (error as { retryAfterMs?: number }).retryAfterMs,
            },
          ],
        };
      }
    },
    async acquire(input) {
      if (
        input.providerId !== PROVIDER ||
        input.format !== 'pdf' ||
        input.stableId.length > 300 ||
        input.revision.length > 1000
      )
        throw new Error('Unsupported first-edition acquisition.');
      const match = /^im-first-edition:(\/[^#]+)#([a-zA-Z0-9]{20,64})$/.exec(
        input.stableId,
      );
      if (!match || imPagePath(match[1]).path !== match[1])
        throw new Error('Invalid selected first-edition identity.');
      const selected = JSON.parse(input.revision) as Revision;
      if (
        !selected ||
        Object.keys(selected).sort().join(',') !==
          'etag,length,modified,page,v' ||
        selected.v !== 1 ||
        typeof selected.page !== 'string' ||
        !/^[a-f0-9]{64}$/.test(selected.page) ||
        typeof selected.etag !== 'string' ||
        !/^"[\x21\x23-\x7e]{1,200}"$/.test(selected.etag) ||
        !Number.isSafeInteger(selected.length) ||
        selected.length < 5 ||
        selected.length > pdfCap ||
        typeof selected.modified !== 'string' ||
        selected.modified.length > 100 ||
        !Number.isFinite(Date.parse(selected.modified))
      )
        throw new Error('Invalid selected first-edition revision.');
      return await operation(async (request) => {
        const { parsed, revision } = await html(request, match[1]);
        if (
          revision !== selected.page ||
          !parsed.licensed ||
          !parsed.attribution ||
          !parsed.artifacts.some((a) => a.id === match[2] && a.allowed)
        )
          throw new Error(
            'Selected artifact, role, license or page revision changed.',
          );
        const response = await request(
          `${IM_ASSET_ORIGIN}/${match[2]}`,
          'GET',
          {
            'if-match': selected.etag,
            'if-unmodified-since': selected.modified,
          },
        );
        const actual = validators(response, pdfCap);
        if (
          actual.etag !== selected.etag ||
          actual.length !== selected.length ||
          actual.modified !== selected.modified
        ) {
          await response.body?.cancel();
          throw new Error('Selected PDF revision changed.');
        }
        const bytes = await readBody(response, pdfCap);
        if (
          bytes.length !== selected.length ||
          new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-'
        )
          throw new Error('Selected body is not the declared PDF.');
        return { bytes, revision: input.revision, sha256: await sha256(bytes) };
      });
    },
  };
}
