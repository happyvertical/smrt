/**
 * Document conversion for Office course-bundle members (SMRT #4615).
 *
 * Untrusted Word and PowerPoint files never run next to the application: the
 * app only talks to a `DocumentConverter`, which renders a member to PDF in an
 * isolated service. The importer enforces the byte and time limits itself, so
 * a misbehaving adapter cannot exceed them.
 */

/** Office kinds the importer can render. */
export type OfficeDocumentKind = 'docx' | 'pptx' | 'xlsx';
export const OFFICE_DOCUMENT_KINDS: readonly OfficeDocumentKind[] = [
  'docx',
  'pptx',
  'xlsx',
];
export const isOfficeDocumentKind = (
  value: unknown,
): value is OfficeDocumentKind =>
  (OFFICE_DOCUMENT_KINDS as readonly unknown[]).includes(value);

export const OFFICE_MEDIA_TYPES: Readonly<Record<OfficeDocumentKind, string>> =
  Object.freeze({
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

export const DEFAULT_DOCUMENT_CONVERSION_TIMEOUT_MS = 60_000;
export const DEFAULT_DOCUMENT_CONVERSION_MAX_BYTES = 50 * 1024 * 1024;

export interface DocumentConversionLimits {
  /** Largest input handed to the converter, in bytes. */
  maxInputBytes: number;
  /** Largest rendered PDF accepted back, in bytes. */
  maxOutputBytes: number;
  /** Wall-clock budget for one conversion, in milliseconds. */
  timeoutMs: number;
}

export interface DocumentConversionRequest {
  bytes: Uint8Array;
  kind: OfficeDocumentKind;
  /** A neutral file name (extension only matters); never the bundle path. */
  fileName: string;
  limits: DocumentConversionLimits;
  /** Aborted when the time budget is spent; adapters must honour it. */
  signal: AbortSignal;
}

export interface DocumentConversionResult {
  /** The rendered document as a PDF. */
  pdf: Uint8Array;
  /**
   * Optional image of the first page (PNG, JPEG or WebP), when the converter
   * can draw one. Absent or unusable reads as "no thumbnail"; it never costs
   * the member its pages.
   */
  thumbnail?: Uint8Array | null;
}

/** Render an Office document to PDF. Implementations must not retain the bytes. */
export interface DocumentConverter {
  /** Stable identifier recorded as provenance (for example `gotenberg`). */
  readonly id: string;
  convertToPdf(
    request: DocumentConversionRequest,
  ): Promise<DocumentConversionResult>;
}

export type DocumentConversionFailure =
  /** The service could not be reached or answered with a server error. */
  | 'unavailable'
  | 'timeout'
  | 'too_large'
  /** The service refused or could not render this file. */
  | 'rejected'
  /** The answer was not a usable PDF. */
  | 'invalid_output';

export class DocumentConversionError extends Error {
  constructor(
    readonly code: DocumentConversionFailure,
    message?: string,
  ) {
    super(message ?? `Document conversion failed: ${code}.`);
    this.name = 'DocumentConversionError';
  }
}

/** Text of an Office document as read by an SDK processor (never learner-visible by default). */
export interface OfficeText {
  /** Whole-document text. */
  text: string;
  /** PPTX only: slide text and speaker notes per slide, in order. */
  slides?: Array<{ index: number; text: string; notes?: string }>;
}

/**
 * Injectable text reader for Office members. Return `null` when the engine is
 * unavailable. `createOfficeTextReader(extractOffice)` adapts the SDK processor
 * (`@happyvertical/documents` >= 0.111.4, sdk#1486) without this package
 * depending on it: the host imports `extractOffice` and passes it in.
 */
export interface OfficeTextReader {
  read(input: {
    bytes: Uint8Array;
    kind: OfficeDocumentKind;
  }): Promise<OfficeText | null>;
}

/** The shape of an SDK document part that the reader below reads (`DocumentPart`). */
export interface OfficeExtractPart {
  content?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  parts?: OfficeExtractPart[];
}
/** `extractOffice` of `@happyvertical/documents` (structural, so no dependency is declared). */
export type OfficeExtractFunction = (
  source: Uint8Array,
  format: 'docx' | 'pptx',
  options?: { extractImages?: boolean },
) => Promise<
  | { status: 'ok'; parts: OfficeExtractPart[] }
  | { status: 'unsupported'; [key: string]: unknown }
>;

const flatText = (part: OfficeExtractPart): string[] => [
  part.content ?? '',
  ...(part.parts ?? []).flatMap(flatText),
];

/**
 * Adapt the SDK Office extractor to an `OfficeTextReader`: whole-document text
 * for Word, text and speaker notes per slide for PowerPoint. Images are never
 * requested. An unsupported engine (Kreuzberg not installed) reads as `null`;
 * a corrupt file rejects, and the importer treats that as "no text".
 */
export function createOfficeTextReader(
  extractOffice: OfficeExtractFunction,
): OfficeTextReader {
  return {
    async read({ bytes, kind }) {
      // The SDK reads Word and PowerPoint; a workbook has no text reader.
      if (kind === 'xlsx') return null;
      const result = await extractOffice(bytes, kind, { extractImages: false });
      if (result.status !== 'ok') return null;
      const text = result.parts
        .flatMap(flatText)
        .map((t) => t.trim())
        .filter(Boolean)
        .join('\n\n');
      if (kind !== 'pptx') return { text };
      return {
        text,
        slides: result.parts.map((part, i) => {
          const slide = Number(part.metadata?.slide);
          return {
            index: Number.isSafeInteger(slide) && slide > 0 ? slide : i + 1,
            text: flatText(part)
              .map((t) => t.trim())
              .filter(Boolean)
              .join('\n'),
            ...(part.notes?.trim() ? { notes: part.notes.trim() } : {}),
          };
        }),
      };
    },
  };
}

// -- Gotenberg ----------------------------------------------------------------

export interface GotenbergConverterOptions {
  /** Base URL of the Gotenberg service, for example `http://gotenberg:3000`. */
  baseUrl: string;
  /** Per-request timeout; the importer's own budget still applies. */
  timeoutMs?: number;
  /** Largest input sent and largest response read, in bytes. */
  maxBytes?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const PDF_MAGIC = '%PDF-';
/** True when the bytes start like a PDF (header within the first KiB). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      Math.min(bytes.byteLength, 1024),
    ).indexOf(PDF_MAGIC) !== -1
  );
}

async function readCapped(
  response: Response,
  max: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max)
    throw new DocumentConversionError('too_large');
  if (!response.body) throw new DocumentConversionError('invalid_output');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new DocumentConversionError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Gotenberg (LibreOffice in a container) over HTTP. The only network it ever
 * touches is `baseUrl`; redirects are refused, credentials in the URL are
 * rejected and the response body is read with a hard size cap. Deploy the
 * service with no outbound network of its own.
 */
export class GotenbergDocumentConverter implements DocumentConverter {
  readonly id = 'gotenberg';
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GotenbergConverterOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new Error('Gotenberg baseUrl must be an absolute http(s) URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('Gotenberg baseUrl must be an absolute http(s) URL');
    if (url.username || url.password)
      throw new Error('Gotenberg baseUrl must not carry credentials');
    this.endpoint = `${url.origin}${url.pathname.replace(/\/+$/, '')}/forms/libreoffice/convert`;
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_DOCUMENT_CONVERSION_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_DOCUMENT_CONVERSION_MAX_BYTES;
    this.fetchImpl = options.fetch ?? fetch;
    if (!(this.timeoutMs > 0) || !(this.maxBytes > 0))
      throw new Error('Gotenberg timeoutMs and maxBytes must be positive');
  }

  async convertToPdf(
    request: DocumentConversionRequest,
  ): Promise<DocumentConversionResult> {
    const maxIn = Math.min(this.maxBytes, request.limits.maxInputBytes);
    const maxOut = Math.min(this.maxBytes, request.limits.maxOutputBytes);
    if (request.bytes.byteLength > maxIn)
      throw new DocumentConversionError('too_large');
    const timeout = AbortSignal.timeout(
      Math.min(this.timeoutMs, request.limits.timeoutMs),
    );
    const signal = AbortSignal.any([request.signal, timeout]);
    const form = new FormData();
    form.append(
      'files',
      new Blob([request.bytes as unknown as ArrayBuffer], {
        type: OFFICE_MEDIA_TYPES[request.kind],
      }),
      request.fileName,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        body: form,
        redirect: 'error',
        signal,
      });
    } catch {
      throw new DocumentConversionError(
        signal.aborted ? 'timeout' : 'unavailable',
      );
    }
    try {
      if (response.status >= 500)
        throw new DocumentConversionError('unavailable');
      if (!response.ok) throw new DocumentConversionError('rejected');
      const pdf = await readCapped(response, maxOut);
      if (!looksLikePdf(pdf))
        throw new DocumentConversionError('invalid_output');
      return { pdf };
    } catch (error) {
      if (error instanceof DocumentConversionError) throw error;
      throw new DocumentConversionError(
        signal.aborted ? 'timeout' : 'unavailable',
      );
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  }
}

// -- fake ---------------------------------------------------------------------

export interface FakeDocumentConverterOptions {
  /** Throw this failure for every call. */
  failWith?: DocumentConversionFailure;
  /** Fail only when this predicate matches the input bytes. */
  failWhen?: (request: DocumentConversionRequest) => boolean;
  /** Wait this long (honouring the abort signal) before answering. */
  delayMs?: number;
  /** Bytes to return instead of the built-in one-page PDF. */
  output?: Uint8Array;
  /** First-page image to return beside the PDF (none by default). */
  thumbnail?: Uint8Array;
}

/** Deterministic in-memory converter for tests. Records every call. */
export class FakeDocumentConverter implements DocumentConverter {
  readonly id = 'fake';
  readonly calls: Array<{
    kind: OfficeDocumentKind;
    fileName: string;
    byteLength: number;
  }> = [];

  constructor(private readonly options: FakeDocumentConverterOptions = {}) {}

  async convertToPdf(
    request: DocumentConversionRequest,
  ): Promise<DocumentConversionResult> {
    this.calls.push({
      kind: request.kind,
      fileName: request.fileName,
      byteLength: request.bytes.byteLength,
    });
    if (this.options.delayMs)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.delayMs);
        request.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DocumentConversionError('timeout'));
          },
          { once: true },
        );
      });
    if (this.options.failWith)
      throw new DocumentConversionError(this.options.failWith);
    if (this.options.failWhen?.(request))
      throw new DocumentConversionError('rejected');
    return {
      pdf:
        this.options.output ??
        Buffer.from(
          `%PDF-1.4\n% rendered ${request.kind} ${request.bytes.byteLength}\n%%EOF\n`,
        ),
      ...(this.options.thumbnail ? { thumbnail: this.options.thumbnail } : {}),
    };
  }
}
