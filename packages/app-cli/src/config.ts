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

/** Shape stored on disk in the app's CLI config file. */
export interface CliConfig {
  serverUrl?: string;
  token?: string;
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
}

const DEFAULT_LOCAL_SERVER = 'http://localhost:5173';

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
  return url.replace(/\/+$/u, '');
}

/** Resolve the stored bearer token (env var wins over config). */
export async function getStoredToken(
  context: CliConfigContext,
  config?: CliConfig,
): Promise<string | undefined> {
  const resolved = config ?? (await loadCliConfig(context));
  return process.env[`${context.envPrefix}_TOKEN`] ?? resolved.token;
}

/** Remove the token from the config file (e.g. on logout). */
export async function clearStoredToken(
  context: CliConfigContext,
): Promise<void> {
  const config = await loadCliConfig(context);
  delete config.token;
  await saveCliConfig(context, config);
}

/** Persist a login: writes both serverUrl and token to the config file. */
export async function saveAuth(
  context: CliConfigContext,
  serverUrl: string,
  token: string,
): Promise<void> {
  const config = await loadCliConfig(context);
  await saveCliConfig(context, {
    ...config,
    serverUrl: serverUrl.replace(/\/+$/u, ''),
    token,
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
  // Reuse the caller's pre-loaded config when supplied, otherwise read
  // from disk. (#1311 review P2.)
  const config = options.loadedConfig ?? (await loadCliConfig(context));
  const serverUrl = (
    options.serverUrl ?? (await getServerUrl(context, config))
  ).replace(/\/+$/u, '');
  const token = await getStoredToken(context, config);
  const headers = new Headers(init.headers);

  if (options.requireAuth && options.auth !== false && !token) {
    throw new Error(
      `Not authenticated. Run \`${context.envPrefix.toLowerCase()} auth login\` first.`,
    );
  }

  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  if (options.auth !== false && token) {
    headers.set('authorization', `Bearer ${token}`);
  }

  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${serverUrl}${path}`, {
    ...init,
    headers,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const text = await readBodyWithCap(response, maxBytes);
  const parsed =
    contentType.includes('application/json') && text
      ? (JSON.parse(text) as unknown)
      : (text as unknown);

  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${response.status}: ${response.statusText}`;
    // Attach the HTTP status as a property so downstream callers (e.g.
    // the auth-login polling loop) can distinguish transient 5xx from
    // terminal 4xx without parsing the message string. Server-supplied
    // `error` fields stay verbatim in `.message` for the user-facing
    // CLI output. (#1311 review #2.)
    throw Object.assign(new Error(message), { status: response.status });
  }

  return parsed as T;
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
    throw new Error(
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
        throw new Error(
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
