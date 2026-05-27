/**
 * Tests for the CLI config + JSON request helper.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CliConfigContext,
  clearStoredToken,
  getServerUrl,
  getStoredToken,
  loadCliConfig,
  requestJson,
  saveAuth,
  saveCliConfig,
} from '../cli.js';

describe('CLI config + request helper', () => {
  let context: CliConfigContext;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'smrt-app-mcp-cli-'));
    const configPath = join(tmp, 'config.json');
    process.env.SAMPLE_CLI_CONFIG = configPath;
    delete process.env.SAMPLE_SERVER_URL;
    delete process.env.SAMPLE_TOKEN;
    context = {
      envPrefix: 'SAMPLE',
      defaultServerUrl: 'https://default.example.com',
    };
  });

  afterEach(() => {
    delete process.env.SAMPLE_CLI_CONFIG;
    delete process.env.SAMPLE_SERVER_URL;
    delete process.env.SAMPLE_TOKEN;
    rmSync(tmp, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it('returns an empty config when the file is missing', async () => {
    expect(await loadCliConfig(context)).toEqual({});
  });

  it('saves the config with 0600 permissions and trims trailing slashes', async () => {
    await saveAuth(context, 'https://app.example.com//', 'token-123');
    const path = process.env.SAMPLE_CLI_CONFIG!;
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      serverUrl: 'https://app.example.com',
      token: 'token-123',
    });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('resolves server url and token: env wins, then config file, then default', async () => {
    expect(await getServerUrl(context)).toBe('https://default.example.com');
    expect(await getStoredToken(context)).toBeUndefined();

    await saveCliConfig(context, {
      serverUrl: 'https://from-config',
      token: 'config-token',
    });
    expect(await getServerUrl(context)).toBe('https://from-config');
    expect(await getStoredToken(context)).toBe('config-token');

    process.env.SAMPLE_SERVER_URL = 'https://from-env';
    process.env.SAMPLE_TOKEN = 'env-token';
    expect(await getServerUrl(context)).toBe('https://from-env');
    expect(await getStoredToken(context)).toBe('env-token');
  });

  it('clears the stored token but keeps the rest of the config', async () => {
    await saveAuth(context, 'https://app', 'tok');
    await clearStoredToken(context);
    expect(await loadCliConfig(context)).toEqual({ serverUrl: 'https://app' });
  });

  it('attaches the bearer token to requests and parses JSON responses', async () => {
    await saveAuth(context, 'https://app.example.com', 'secret-token');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const body = await requestJson(
      context,
      '/api/something',
      { method: 'GET' },
      { fetch: fetchMock },
    );
    expect(body).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://app.example.com/api/something');
    expect((init as RequestInit).headers).toBeInstanceOf(Headers);
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer secret-token');
  });

  it('throws when requireAuth is set and no token is stored', async () => {
    const fetchMock = vi.fn();
    await expect(
      requestJson(context, '/x', {}, { requireAuth: true, fetch: fetchMock }),
    ).rejects.toThrow(/Not authenticated/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws the server error message on non-2xx JSON responses', async () => {
    await saveAuth(context, 'https://app.example.com', 'tok');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      requestJson(context, '/x', {}, { fetch: fetchMock }),
    ).rejects.toThrow('forbidden');
  });
});
