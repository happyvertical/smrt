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

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
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
  const config = await loadCliConfig(context);
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
  const text = await response.text();
  const parsed =
    contentType.includes('application/json') && text
      ? (JSON.parse(text) as unknown)
      : (text as unknown);

  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${response.status}: ${response.statusText}`;
    throw new Error(message);
  }

  return parsed as T;
}

export {
  createMcpStdioBridge,
  type McpStdioBridgeOptions,
  runMcpStdioBridge,
} from './bridge.js';
