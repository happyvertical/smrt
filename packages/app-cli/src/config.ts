/**
 * Shared CLI helpers for SMRT apps: a small config file format, env var
 * resolution with a configurable prefix, and a minimal JSON HTTP client
 * that knows how to bear the stored CLI token.
 *
 * The same helpers back the stdio bridge (`smrt-mcp-bridge`) and any
 * app-specific `data`-style commands that talk to the app's HTTP API.
 *
 * @packageDocumentation
 */

import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AppResultMetadata,
  DeclaredActionField,
  JsonValue,
} from '@happyvertical/smrt-users/app-contract';
import { SMRT_MCP_RESULT_METADATA_KEY } from '@happyvertical/smrt-users/app-contract';

/** Shape stored on disk in the app's CLI config file. */
export interface CliConfig {
  /** Issuer selected for the currently configured server. */
  credentialIssuer?: string;
  serverUrl?: string;
  /** Legacy single-token field. Read only when its stored server still matches. */
  token?: string;
  /** Bearer credentials keyed by their exact issuer identifier. */
  tokensByIssuer?: Record<string, string>;
}

/**
 * Configuration for the env-var/config-file resolution chain.
 *
 * Env vars derived from `envPrefix`:
 *
 *  - `${PREFIX}_SERVER_URL`
 *  - `${PREFIX}_TOKEN`
 *  - `${PREFIX}_CLI_CONFIG` (overrides config file path)
 */
export interface CliConfigContext {
  /**
   * Uppercase prefix for env vars and the app's namespaced config dir.
   * Example: `WILLGRIFFIN` → reads `WILLGRIFFIN_SERVER_URL`, defaults the
   * config file to `~/.config/willgriffin/config.json` unless `appSlug`
   * overrides the directory name.
   */
  envPrefix: string;
  /** Directory name under `~/.config`. Defaults to lowercased `envPrefix`. */
  appSlug?: string;
  /** Fallback server URL if neither env nor config sets one. */
  defaultServerUrl?: string;
  /**
   * Require HTTPS for every resolved or request-level server URL, while still
   * permitting loopback HTTP for local development.
   */
  requireSecureServerUrl?: boolean;
}

const DEFAULT_LOCAL_SERVER = 'http://localhost:5173';

/** Enforce the executable-safe server URL policy without echoing URL values. */
export function assertSecureServerUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid server URL configuration.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid server URL configuration.');
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (url.protocol === 'http:' && !localHosts.has(url.hostname)) {
    throw new Error('Invalid server URL configuration.');
  }
}

function normalizeServerUrl(context: CliConfigContext, value: string): string {
  const normalized = value.replace(/\/+$/u, '');
  if (context.requireSecureServerUrl) assertSecureServerUrl(normalized);
  return normalized;
}

function configFilePath(context: CliConfigContext): string {
  const override = process.env[`${context.envPrefix}_CLI_CONFIG`];
  if (override) return override;
  const slug = context.appSlug ?? context.envPrefix.toLowerCase();
  return join(homedir(), '.config', slug, 'config.json');
}

/** Read the CLI config file. Missing file → empty config. */
export async function loadCliConfig(
  context: CliConfigContext,
): Promise<CliConfig> {
  try {
    const raw = await readFile(configFilePath(context), 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw) as CliConfig;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: string }).code === 'ENOENT'
    ) {
      return {};
    }
    throw error;
  }
}

/**
 * Write the CLI config to disk with 0600 permissions (the token is a bearer
 * credential — anyone who can read the file can impersonate the user).
 */
export async function saveCliConfig(
  context: CliConfigContext,
  config: CliConfig,
): Promise<void> {
  const path = configFilePath(context);
  const dir = dirname(path);

  // 0o700 on the parent. `mkdir(... { recursive: true, mode })` only
  // applies the mode to dirs it CREATES — a pre-existing dir at 0o755
  // (e.g. from a legacy install or another tool) keeps its old perms
  // and remains world-traversable. Explicit chmod after mkdir enforces
  // the intent regardless of how the dir got there. We swallow chmod
  // failures so a read-only mount or a dir owned by another user
  // doesn't break saveCliConfig entirely. (#1311 review A1 + #4.)
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);

  // Atomic write: tempfile in the same dir with mode 0o600, then rename
  // over the target. Without this, a SIGKILL between writeFile and
  // chmod could leave the bearer token at the umask-modified 0o644 /
  // 0o664. `writeFile { mode }` honours mode only on file CREATE, but
  // the underlying open(2) is still subject to umask on Linux until
  // chmod runs. The rename is atomic on POSIX (same filesystem), so
  // readers either see the old config or the fully-written new one.
  // (#1311 review #3.)
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** Resolve the server URL: env var → config file → `defaultServerUrl`. */
export async function getServerUrl(
  context: CliConfigContext,
  config?: CliConfig,
): Promise<string> {
  const resolved = config ?? (await loadCliConfig(context));
  const url =
    process.env[`${context.envPrefix}_SERVER_URL`] ??
    resolved.serverUrl ??
    context.defaultServerUrl ??
    DEFAULT_LOCAL_SERVER;
  return normalizeServerUrl(context, url);
}

/** Resolve a bearer token only when it is bound to the exact target server. */
export async function getStoredToken(
  context: CliConfigContext,
  config?: CliConfig,
  serverUrl?: string,
): Promise<string | undefined> {
  const resolved = config ?? (await loadCliConfig(context));
  const targetServer = (
    serverUrl ?? (await getServerUrl(context, resolved))
  ).replace(/\/+$/u, '');
  const environmentToken = process.env[`${context.envPrefix}_TOKEN`];
  const environmentServer = process.env[
    `${context.envPrefix}_SERVER_URL`
  ]?.replace(/\/+$/u, '');
  if (environmentToken) {
    return environmentServer === targetServer ? environmentToken : undefined;
  }

  const configuredServer = resolved.serverUrl?.replace(/\/+$/u, '');
  if (!configuredServer || configuredServer !== targetServer) return undefined;

  if (resolved.credentialIssuer) {
    return resolved.tokensByIssuer?.[resolved.credentialIssuer];
  }

  // Legacy configs predate issuer-keyed storage. They remain usable only for
  // the exact server saved alongside the token and migrate on the next login.
  return resolved.token;
}

/** Remove the token from the config file (e.g. on logout). */
export async function clearStoredToken(
  context: CliConfigContext,
): Promise<void> {
  const config = await loadCliConfig(context);
  if (config.credentialIssuer && config.tokensByIssuer) {
    delete config.tokensByIssuer[config.credentialIssuer];
    if (Object.keys(config.tokensByIssuer).length === 0) {
      delete config.tokensByIssuer;
    }
  }
  delete config.credentialIssuer;
  delete config.token;
  await saveCliConfig(context, config);
}

/** Persist a login with the bearer token keyed by its exact issuer. */
export async function saveAuth(
  context: CliConfigContext,
  serverUrl: string,
  token: string,
  issuer = serverUrl,
): Promise<void> {
  const config = await loadCliConfig(context);
  const normalizedServerUrl = serverUrl.replace(/\/+$/u, '');
  if (!issuer.trim()) throw new Error('Credential issuer must not be empty.');
  const exactIssuer = issuer;
  await saveCliConfig(context, {
    ...config,
    credentialIssuer: exactIssuer,
    serverUrl: normalizedServerUrl,
    token: undefined,
    tokensByIssuer: {
      [exactIssuer]: token,
    },
  });
}

/** Options for `requestJson`. */
export interface RequestJsonOptions {
  /**
   * When false, skip sending the Authorization header even if a token is
   * present. Defaults to true.
   */
  auth?: boolean;
  /**
   * When true, throw if no token is available and `auth` is not false.
   * Defaults to false.
   */
  requireAuth?: boolean;
  /** Override the server URL for this request. */
  serverUrl?: string;
  /** Override the fetch implementation (tests). */
  fetch?: typeof fetch;
  /**
   * Cap on response body size in bytes. The CLI buffers the full body
   * before JSON-parsing, so without this cap a misbehaving or malicious
   * server could OOM the CLI process with a multi-GB payload (auth and
   * discovery both use this code path). Defaults to 10MB — large enough
   * for any sensible discovery response, small enough that overflow is
   * a clear signal something's wrong. Pass `Infinity` to disable.
   * (#1311 review A4.)
   */
  maxResponseBytes?: number;
  /**
   * Pre-loaded config to avoid re-reading from disk. Set by callers that
   * already have it (e.g. `buildAppContext`); leave undefined for the
   * default behavior of loading per-call. (#1311 review P2.)
   */
  loadedConfig?: CliConfig;
}

const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Structured metadata preserved for CLI JSON and MCP bridge consumers. */
export type AppCliResultMetadata = AppResultMetadata;
export type { DeclaredActionField };

export interface RequestJsonSuccess<T> {
  ok: true;
  result: T;
  metadata: AppCliResultMetadata;
}

export interface RequestJsonFailure {
  ok: false;
  status: number;
  error: AppCliResultMetadata;
}

/** Generic result/error envelope for a JSON request. */
export type RequestJsonResult<T> = RequestJsonSuccess<T> | RequestJsonFailure;

/** Error compatibility wrapper returned by the legacy throwing helper. */
export class AppCliRequestError extends Error {
  readonly status: number;
  readonly metadata: AppCliResultMetadata;

  constructor(status: number, metadata: AppCliResultMetadata) {
    super(metadata.message ?? `HTTP ${status}`);
    this.name = 'AppCliRequestError';
    this.status = status;
    this.metadata = metadata;
  }
}

/**
 * JSON request helper that injects the stored bearer token. Returns the
 * parsed JSON body on success; throws an `Error` with the server's `error`
 * field (or `HTTP <status>`) on failure.
 */
export async function requestJson<T = unknown>(
  context: CliConfigContext,
  path: string,
  init: RequestInit = {},
  options: RequestJsonOptions = {},
): Promise<T> {
  const outcome = await requestJsonResult<T>(context, path, init, options);
  if (!outcome.ok) {
    throw new AppCliRequestError(outcome.status, outcome.error);
  }
  return outcome.result;
}

/**
 * Issue a JSON request without flattening a failure to an Error message.
 *
 * Metadata is deliberately copied only from conventional result/error fields
 * and response headers. Every value crossing this boundary is redacted before
 * a CLI or MCP client can observe it.
 */
export async function requestJsonResult<T = unknown>(
  context: CliConfigContext,
  path: string,
  init: RequestInit = {},
  options: RequestJsonOptions = {},
): Promise<RequestJsonResult<T>> {
  // Reuse the caller's pre-loaded config when supplied, otherwise read
  // from disk. (#1311 review P2.)
  const config = options.loadedConfig ?? (await loadCliConfig(context));
  const serverUrl = normalizeServerUrl(
    context,
    options.serverUrl ?? (await getServerUrl(context, config)),
  );
  const token = await getStoredToken(context, config, serverUrl);
  const headers = new Headers(init.headers);

  if (options.requireAuth && options.auth !== false && !token) {
    return failure(401, {
      code: 'not_authenticated',
      message: `Not authenticated. Run \`${context.envPrefix.toLowerCase()} auth login\` first.`,
      retryable: false,
    });
  }

  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  if (options.auth !== false && token) {
    headers.set('authorization', `Bearer ${token}`);
  }

  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${serverUrl}${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    return failure(0, {
      code: 'network_error',
      message: redactMessage(
        error instanceof Error ? error.message : String(error),
      ),
      retryable: true,
    });
  }

  const contentType = response.headers.get('content-type') ?? '';
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  let text: string;
  try {
    text = await readBodyWithCap(response, maxBytes);
  } catch (error) {
    if (!(error instanceof ResponseTooLargeError)) {
      return failure(0, {
        code: 'network_error',
        message: redactMessage(
          error instanceof Error ? error.message : String(error),
        ),
        retryable: true,
      });
    }
    return failure(response.status, {
      code: 'response_too_large',
      message: redactMessage(
        error instanceof Error ? error.message : String(error),
      ),
      retryable: response.status >= 500,
    });
  }
  let parsed: unknown = text;
  if (contentType.includes('application/json') && text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return failure(response.status, {
        code: 'invalid_json_response',
        message: 'Server returned invalid JSON.',
        retryable: response.status >= 500,
      });
    }
  }

  if (!response.ok) {
    return failure(
      response.status,
      metadataFromResponse(
        parsed,
        response.headers,
        `http_${response.status}`,
        response.status >= 500 ||
          response.status === 408 ||
          response.status === 429,
        `HTTP ${response.status}: ${response.statusText}`,
      ),
    );
  }

  return {
    ok: true,
    result: parsed as T,
    metadata: metadataFromResponse(parsed, response.headers, 'ok', false),
  };
}

/** Redact conventional credential fields before emitting transport metadata. */
export function redactTransportValue(value: unknown): unknown {
  if (typeof value === 'string') return redactMessage(value);
  if (Array.isArray(value)) return value.map(redactTransportValue);
  if (!isRecord(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : redactTransportValue(nested);
  }
  return redacted;
}

function failure(
  status: number,
  error: AppCliResultMetadata,
): RequestJsonFailure {
  return { ok: false, status, error };
}

function metadataFromResponse(
  payload: unknown,
  headers: Headers,
  fallbackCode: string,
  fallbackRetryable: boolean,
  fallbackMessage?: string,
): AppCliResultMetadata {
  const record = isRecord(payload) ? payload : undefined;
  const error = record && isRecord(record.error) ? record.error : undefined;
  const meta = firstRecord(
    error,
    record && isRecord(record.metadata) ? record.metadata : undefined,
    record && isRecord(record.meta) ? record.meta : undefined,
    getMcpMetadata(record),
    record,
  );
  const message = firstString(
    meta?.message,
    error?.message,
    typeof record?.error === 'string' ? record.error : undefined,
    fallbackMessage,
  );
  const details = meta?.details ?? error?.details;
  const correlationId = firstString(
    meta?.correlationId,
    error?.correlationId,
    headers.get('x-correlation-id') ?? undefined,
    headers.get('x-request-id') ?? undefined,
  );
  const idempotencyKey = declaredActionField(
    meta?.idempotencyKey ?? meta?.idempotency,
  );
  const expectedVersion = declaredActionField(meta?.expectedVersion);
  return {
    code: firstString(meta?.code, error?.code) ?? fallbackCode,
    ...(message ? { message: redactMessage(message) } : {}),
    ...(details !== undefined
      ? { details: redactTransportValue(details) as JsonValue }
      : {}),
    retryable:
      typeof meta?.retryable === 'boolean'
        ? meta.retryable
        : typeof error?.retryable === 'boolean'
          ? error.retryable
          : fallbackRetryable,
    ...(correlationId ? { correlationId: redactMessage(correlationId) } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(expectedVersion ? { expectedVersion } : {}),
  };
}

function getMcpMetadata(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!record || !isRecord(record._meta)) return undefined;
  const meta = record._meta[SMRT_MCP_RESULT_METADATA_KEY];
  return isRecord(meta) ? meta : undefined;
}

function declaredActionField(value: unknown): DeclaredActionField | undefined {
  if (!isRecord(value) || typeof value.field !== 'string') return undefined;
  return { field: value.field, required: value.required === true };
}

function firstRecord(
  ...values: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  return values.find((value) => value !== undefined);
}

function firstString(...values: Array<unknown>): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value !== '',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|token|secret|password|cookie|credential|api[-_]?key)/iu.test(
    key,
  );
}

function redactMessage(message: string): string {
  return message
    .replace(/bearer\s+[a-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(
      /((?:token|secret|password|api[-_]?key|authorization)=)[^&\s,]+/giu,
      '$1[REDACTED]',
    );
}

class ResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Read the response body into a UTF-8 string, capping at `maxBytes`. On
 * overflow, throw with a clear message — better than OOM-ing the CLI
 * when a server returns a multi-GB body. Streams chunk-by-chunk so the
 * check fires before the whole body is buffered. (#1311 review A4.)
 */
async function readBodyWithCap(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return '';
  // Content-Length fast path — if the server tells us up front the body
  // is too big, abort the connection without buffering anything.
  const cl = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(cl) && cl > maxBytes) {
    try {
      await response.body.cancel();
    } catch {
      // Stream may already be locked/closed.
    }
    throw new ResponseTooLargeError(
      `Response too large: ${cl} bytes exceeds ${maxBytes}-byte cap`,
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new ResponseTooLargeError(
          `Response too large: exceeded ${maxBytes}-byte cap mid-stream`,
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader is still active during normal completion — releaseLock
      // throws in that case. Safe to ignore.
    }
  }
  return new TextDecoder().decode(
    Buffer.concat(chunks.map((c) => Buffer.from(c))),
  );
}

export {
  createMcpStdioBridge,
  type McpStdioBridgeOptions,
  runMcpStdioBridge,
} from './bridge.js';
