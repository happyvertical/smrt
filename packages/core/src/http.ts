/**
 * Bounded Web Standard Request / Node.js HTTP server helpers, trusted-proxy
 * client IP extraction, and LRU-bounded sliding-window rate limiting.
 *
 * Extracted from production SMRT HTTP services so applications and relays do
 * not need to hand-roll streaming body-size enforcement, JSON content-type
 * validation, right-to-left `X-Forwarded-For` parsing, or `node:http`
 * `IncomingMessage` <-> `Request`/`Response` adapters.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Default maximum bytes accepted for JSON request bodies (64 KiB). */
export const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * Client-visible 400 Bad Request error compatible with `normalizeTypedHttpError`.
 */
export class HttpBadRequestError extends Error {
  readonly status = 400;
  readonly code = 'bad_request';
  readonly publicMessage: string;

  constructor(message: string) {
    super(message);
    this.name = 'HttpBadRequestError';
    this.publicMessage = message;
  }
}

/**
 * Client-visible 413 Payload Too Large error compatible with `normalizeTypedHttpError`.
 */
export class HttpPayloadTooLargeError extends Error {
  readonly status = 413;
  readonly code = 'payload_too_large';
  readonly publicMessage: string;

  constructor(message = 'Request body exceeds maximum allowed size') {
    super(message);
    this.name = 'HttpPayloadTooLargeError';
    this.publicMessage = message;
  }
}

/**
 * Client-visible 429 Too Many Requests error carrying `retryAfterSeconds`.
 */
export class HttpTooManyRequestsError extends Error {
  readonly status = 429;
  readonly code = 'too_many_requests';
  readonly publicMessage: string;
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds = 60) {
    super(message);
    this.name = 'HttpTooManyRequestsError';
    this.publicMessage = message;
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

/**
 * Format a human-readable body size limit message (KiB or MiB when exact).
 */
export function formatBodyLimitMessage(maxBytes: number): string {
  if (maxBytes >= 1024 * 1024 && maxBytes % (1024 * 1024) === 0) {
    return `Request body exceeds ${maxBytes / (1024 * 1024)} MiB limit`;
  }
  if (maxBytes >= 1024 && maxBytes % 1024 === 0) {
    return `Request body exceeds ${maxBytes / 1024} KiB limit`;
  }
  return `Request body exceeds ${maxBytes} byte limit`;
}

/**
 * Return `true` when `contentType` has media type `application/json`
 * (ignoring optional parameters such as `; charset=utf-8`).
 */
export function isJsonContentType(
  contentType: string | null | undefined,
): boolean {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function parseContentLengthHeader(
  raw: string | null | undefined,
): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new HttpBadRequestError('Malformed Content-Length header');
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpBadRequestError('Invalid Content-Length header');
  }
  return parsed;
}

/**
 * Read a Web Standard `Request` body up to `maxBytes` bytes, rejecting
 * oversized declared `Content-Length` headers before reading and cancelling
 * streaming bodies immediately if accumulated chunks exceed `maxBytes`.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`Invalid maxBytes value: ${String(maxBytes)}`);
  }

  const declaredLength = parseContentLengthHeader(
    request.headers.get('content-length'),
  );
  if (declaredLength !== null && declaredLength > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new HttpPayloadTooLargeError(formatBodyLimitMessage(maxBytes));
  }

  if (!request.body) {
    return new Uint8Array(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.byteLength > 0) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new HttpPayloadTooLargeError(formatBodyLimitMessage(maxBytes));
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeStrictUtf8Json<T>(bytes: Uint8Array): T {
  try {
    return JSON.parse(strictUtf8Decoder.decode(bytes)) as T;
  } catch {
    throw new HttpBadRequestError('Malformed JSON body');
  }
}

/**
 * Parse a required `application/json` request body within `maxBytes`.
 * Throws `HttpBadRequestError` (400) on wrong `Content-Type`, empty body,
 * invalid UTF-8, or invalid JSON, and `HttpPayloadTooLargeError` (413) when
 * exceeding `maxBytes`.
 */
export async function parseJsonRequestBody<T = unknown>(
  request: Request,
  maxBytes: number = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<T> {
  if (!isJsonContentType(request.headers.get('content-type'))) {
    throw new HttpBadRequestError('Content-Type must be application/json');
  }

  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes.byteLength === 0) {
    throw new HttpBadRequestError('Request body must not be empty');
  }

  return decodeStrictUtf8Json<T>(bytes);
}

/**
 * Parse an optional `application/json` request body within `maxBytes`.
 * Empty bodies return `{}` without requiring `Content-Type: application/json`;
 * non-empty bodies require `application/json` and valid UTF-8 JSON.
 */
export async function parseOptionalJsonRequestBody<T = Record<string, unknown>>(
  request: Request,
  maxBytes: number = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<T> {
  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes.byteLength === 0) {
    return {} as T;
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    throw new HttpBadRequestError('Content-Type must be application/json');
  }
  return decodeStrictUtf8Json<T>(bytes);
}

/**
 * Normalize an IP literal, stripping IPv4-mapped IPv6 prefixes (`::ffff:`).
 */
export function normalizeIpAddress(
  raw: string | undefined,
): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.toLowerCase().startsWith('::ffff:')) {
    const mapped = trimmed.slice(7).trim();
    if (mapped.length > 0) {
      return mapped;
    }
  }
  return trimmed;
}

/**
 * Resolve the client IP address from a `Request` and optional socket remote
 * address, counting `trustProxyHops` from the right of `X-Forwarded-For` so
 * client-supplied leftmost entries cannot spoof identity behind reverse proxies.
 */
export function extractClientIp(
  request: Request,
  socketRemoteAddress?: string,
  trustProxyHops: boolean | number = 0,
): string {
  const hops =
    typeof trustProxyHops === 'boolean'
      ? trustProxyHops
        ? 1
        : 0
      : trustProxyHops;
  if (!Number.isSafeInteger(hops) || hops < 0) {
    throw new RangeError(
      `Invalid trustProxyHops value: ${String(trustProxyHops)}`,
    );
  }

  if (hops >= 1) {
    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedFor) {
      const parts = forwardedFor
        .split(',')
        .map((entry) => normalizeIpAddress(entry))
        .filter((entry): entry is string => entry !== undefined);
      if (parts.length >= hops) {
        return parts[parts.length - hops];
      }
    }
  }
  return normalizeIpAddress(socketRemoteAddress) ?? 'local';
}

/**
 * Options for `BoundedSlidingWindowRateLimiter`.
 */
export interface BoundedSlidingWindowRateLimiterOptions {
  /** Maximum events allowed within `windowMs` before rejecting. */
  maxEvents: number;
  /** Sliding window duration in milliseconds. */
  windowMs: number;
  /** Maximum distinct keys retained in memory (LRU-evicted). Defaults to 10,000. */
  maxEntries?: number;
}

/**
 * In-memory LRU-bounded sliding-window rate limiter returning `retryAfterSeconds`
 * when a key reaches `maxEvents` within `windowMs`.
 */
export class BoundedSlidingWindowRateLimiter {
  private readonly entries = new Map<string, number[]>();
  private readonly maxEvents: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;

  constructor(options: BoundedSlidingWindowRateLimiterOptions) {
    if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1) {
      throw new RangeError('maxEvents must be a positive safe integer');
    }
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
      throw new RangeError('windowMs must be a positive safe integer');
    }
    const maxEntries = options.maxEntries ?? 10_000;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive safe integer');
    }
    this.maxEvents = options.maxEvents;
    this.windowMs = options.windowMs;
    this.maxEntries = maxEntries;
  }

  /** Number of currently tracked keys. */
  get size(): number {
    return this.entries.size;
  }

  private pruneKey(key: string, nowMs: number): number[] | undefined {
    const timestamps = this.entries.get(key);
    if (!timestamps) {
      return undefined;
    }
    const cutoff = nowMs - this.windowMs;
    const active = timestamps.filter((ts) => ts > cutoff);
    if (active.length === 0) {
      this.entries.delete(key);
      return undefined;
    }
    if (active.length !== timestamps.length) {
      this.entries.set(key, active);
    }
    return active;
  }

  private evictIfFull(nowMs: number): void {
    if (this.entries.size < this.maxEntries) {
      return;
    }
    const cutoff = nowMs - this.windowMs;
    for (const [key, timestamps] of this.entries) {
      const active = timestamps.filter((ts) => ts > cutoff);
      if (active.length === 0) {
        this.entries.delete(key);
      } else if (active.length !== timestamps.length) {
        this.entries.set(key, active);
      }
    }
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  /**
   * Check whether `key` is currently rate-limited at `nowMs`.
   * Returns `retryAfterSeconds` (>= 1) when limited, or `null` when allowed.
   */
  check(key: string, nowMs: number = Date.now()): number | null {
    const active = this.pruneKey(key, nowMs);
    if (!active || active.length < this.maxEvents) {
      return null;
    }
    const oldestRelevant = active[active.length - this.maxEvents];
    const remainingMs = Math.max(1_000, oldestRelevant + this.windowMs - nowMs);
    return Math.ceil(remainingMs / 1000);
  }

  /**
   * Record an event timestamp for `key` at `nowMs`.
   */
  record(key: string, nowMs: number = Date.now()): void {
    const active = this.pruneKey(key, nowMs) ?? [];
    if (!this.entries.has(key)) {
      this.evictIfFull(nowMs);
    } else {
      this.entries.delete(key);
    }
    active.push(nowMs);
    this.entries.set(key, active);
  }

  /**
   * Remove one recorded event matching `tsMs` (or the most recent entry if
   * pruned/shifted) so transient backend errors do not penalize callers.
   */
  refundOne(key: string, tsMs?: number): void {
    const timestamps = this.entries.get(key);
    if (!timestamps || timestamps.length === 0) {
      return;
    }
    if (tsMs !== undefined) {
      const idx = timestamps.lastIndexOf(tsMs);
      if (idx !== -1) {
        timestamps.splice(idx, 1);
      } else {
        timestamps.pop();
      }
    } else {
      timestamps.pop();
    }
    if (timestamps.length === 0) {
      this.entries.delete(key);
    }
  }

  /**
   * Clear `key` (for example after successful authentication), or all keys when
   * `key` is omitted.
   */
  clear(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(key);
  }
}

/**
 * Options for `createNodeHttpHandler`.
 */
export interface CreateNodeHttpHandlerOptions {
  /**
   * Per-request body byte cap or resolver `(pathname, method) => maxBytes`.
   * Defaults to `DEFAULT_MAX_JSON_BODY_BYTES` (64 KiB).
   */
  maxBodyBytes?: number | ((pathname: string, method: string) => number);
  /**
   * Number of trusted reverse-proxy hops (or `true` for 1). When >= 1, honors
   * `X-Forwarded-Proto` when reconstructing `request.url`. Defaults to `0`.
   */
  trustProxyHops?: boolean | number;
  /**
   * Custom error mapper invoked when URL parsing, body reading, or `handle`
   * throws before response headers are sent.
   */
  onError?: (error: unknown) => Response | Promise<Response>;
}

function defaultErrorResponse(error: unknown): Response {
  if (
    error instanceof HttpBadRequestError ||
    error instanceof HttpPayloadTooLargeError
  ) {
    return new Response(JSON.stringify({ error: error.publicMessage }), {
      status: error.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  if (error instanceof HttpTooManyRequestsError) {
    return new Response(JSON.stringify({ error: error.publicMessage }), {
      status: error.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'retry-after': String(error.retryAfterSeconds),
      },
    });
  }
  return new Response(JSON.stringify({ error: 'Internal server error' }), {
    status: 500,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

const STRIPPED_BUFFERED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function statusForbidsBody(status: number): boolean {
  return (
    (status >= 100 && status < 200) ||
    status === 204 ||
    status === 205 ||
    status === 304
  );
}

/**
 * Write a Web Standard `Response` onto a Node.js `ServerResponse`, preserving
 * multi-header `Set-Cookie` values and stripping hop-by-hop / stale encoding
 * headers after decoding the `Response` payload.
 */
export async function writeWebResponseToNode(
  res: ServerResponse,
  webResponse: Response,
): Promise<void> {
  const body = statusForbidsBody(webResponse.status)
    ? null
    : Buffer.from(await webResponse.arrayBuffer());

  res.statusCode = webResponse.status;
  const setCookies =
    typeof webResponse.headers.getSetCookie === 'function'
      ? webResponse.headers.getSetCookie()
      : [];
  const requestedClose = webResponse.headers
    .get('connection')
    ?.split(',')
    .some((token) => token.trim().toLowerCase() === 'close');

  webResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'set-cookie' && setCookies.length > 0) {
      return;
    }
    if (STRIPPED_BUFFERED_RESPONSE_HEADERS.has(lower)) {
      return;
    }
    res.setHeader(key, value);
  });
  if (setCookies.length > 0) {
    res.setHeader('set-cookie', setCookies);
  }
  if (requestedClose || !res.shouldKeepAlive) {
    res.shouldKeepAlive = false;
    res.setHeader('connection', 'close');
  }
  if (body !== null) {
    res.setHeader('content-length', String(body.byteLength));
  }

  const isHead = res.req?.method?.toUpperCase() === 'HEAD';
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        res.off('close', done);
        res.off('error', done);
        resolve();
      }
    };
    res.once('close', done);
    res.once('error', done);
    if (body === null || isHead) {
      res.end(done);
    } else {
      res.end(body, done);
    }
  });
}

function readNodeRequestBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };

    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBodyBytes) {
        settled = true;
        cleanup();
        req.pause();
        reject(
          new HttpPayloadTooLargeError(formatBodyLimitMessage(maxBodyBytes)),
        );
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAborted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new HttpBadRequestError('Request aborted by client'));
    };

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

function scheduleUnreadBodyTeardown(req: IncomingMessage): void {
  if (req.destroyed || req.complete) {
    return;
  }
  const timer = setTimeout(() => {
    if (!req.destroyed) {
      req.destroy();
    }
  }, 200);
  timer.unref?.();
  req.once('close', () => clearTimeout(timer));
}

/**
 * Adapt a Web Standard `(request: Request, remoteAddress?: string) => Response`
 * handler into a Node.js `http.createServer` listener with streaming byte-cap
 * enforcement prior to buffering request bodies in memory.
 */
export function createNodeHttpHandler(
  handle: (
    request: Request,
    remoteAddress?: string,
  ) => Promise<Response> | Response,
  options: CreateNodeHttpHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const trustHops =
    typeof options.trustProxyHops === 'boolean'
      ? options.trustProxyHops
        ? 1
        : 0
      : (options.trustProxyHops ?? 0);
  if (!Number.isSafeInteger(trustHops) || trustHops < 0) {
    throw new RangeError(
      `Invalid trustProxyHops value: ${String(options.trustProxyHops)}`,
    );
  }
  const mapError = options.onError ?? defaultErrorResponse;
  const maxBodyBytesOption = options.maxBodyBytes;
  const resolveMaxBytes: (pathname: string, method: string) => number =
    typeof maxBodyBytesOption === 'function'
      ? maxBodyBytesOption
      : () => maxBodyBytesOption ?? DEFAULT_MAX_JSON_BODY_BYTES;

  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      let targetUrl: URL;
      try {
        let proto = 'http';
        if (trustHops >= 1) {
          const forwardedProto = req.headers['x-forwarded-proto'];
          const rawProto = Array.isArray(forwardedProto)
            ? forwardedProto[0]
            : forwardedProto;
          if (rawProto?.split(',', 1)[0]?.trim().toLowerCase() === 'https') {
            proto = 'https';
          }
        }
        const host = req.headers.host || 'localhost';
        targetUrl = new URL(req.url ?? '/', `${proto}://${host}`);
      } catch {
        throw new HttpBadRequestError('Invalid request URL');
      }

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const entry of value) {
            headers.append(key, entry);
          }
        } else {
          headers.set(key, value);
        }
      }

      let bodyBuffer: Buffer | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const maxBodyBytes = resolveMaxBytes(targetUrl.pathname, method);
        if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
          throw new RangeError(
            `Invalid maxBodyBytes value: ${String(maxBodyBytes)}`,
          );
        }
        const contentLengthRaw = Array.isArray(req.headers['content-length'])
          ? req.headers['content-length'][0]
          : req.headers['content-length'];
        const declaredLength = parseContentLengthHeader(contentLengthRaw);
        if (declaredLength !== null && declaredLength > maxBodyBytes) {
          req.pause();
          throw new HttpPayloadTooLargeError(
            formatBodyLimitMessage(maxBodyBytes),
          );
        }

        bodyBuffer = await readNodeRequestBody(req, maxBodyBytes);
      }

      const webRequest = new Request(targetUrl, {
        method,
        headers,
        body:
          bodyBuffer && bodyBuffer.byteLength > 0
            ? new Uint8Array(bodyBuffer)
            : undefined,
      });

      const webResponse = await handle(webRequest, req.socket?.remoteAddress);
      await writeWebResponseToNode(res, webResponse);
    } catch (error) {
      const shouldCloseConnection =
        !req.complete ||
        error instanceof HttpPayloadTooLargeError ||
        error instanceof HttpBadRequestError;
      if (shouldCloseConnection) {
        req.pause();
        res.shouldKeepAlive = false;
      }
      if (!res.headersSent) {
        let errorResponse: Response;
        try {
          errorResponse = await mapError(error);
        } catch {
          errorResponse = defaultErrorResponse(
            new Error('Unhandled error mapper failure'),
          );
        }
        try {
          await writeWebResponseToNode(res, errorResponse);
        } catch {
          res.destroy();
        }
      } else {
        try {
          res.end();
        } catch {
          res.destroy();
        }
      }
      if (shouldCloseConnection) {
        scheduleUnreadBodyTeardown(req);
      }
    }
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    void dispatch(req, res).catch(() => {
      try {
        res.destroy();
      } catch {
        // Ignore teardown failures on destroyed sockets.
      }
    });
  };
}
