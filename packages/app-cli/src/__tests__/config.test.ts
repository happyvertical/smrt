/**
 * Tests for config persistence + env-var precedence + requestJson HTTP layer.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
} from '../config.js';

let context: CliConfigContext;
let configFileEnvBackup: string | undefined;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smrt-app-cli-config-'));
  configFileEnvBackup = process.env.TESTCFG_CLI_CONFIG;
  process.env.TESTCFG_CLI_CONFIG = join(dir, 'config.json');
  context = {
    envPrefix: 'TESTCFG',
    appSlug: 'testcfg',
    defaultServerUrl: 'https://default.example',
  };
});

afterEach(async () => {
  delete process.env.TESTCFG_TOKEN;
  delete process.env.TESTCFG_SERVER_URL;
  if (process.env.TESTCFG_CLI_CONFIG) {
    await rm(process.env.TESTCFG_CLI_CONFIG, { force: true }).catch(() => {});
  }
  process.env.TESTCFG_CLI_CONFIG = configFileEnvBackup;
});

describe('config persistence', () => {
  it('save/load round-trip with 0600 perms', async () => {
    await saveAuth(context, 'https://example.test', 'tok_abc');
    const path = process.env.TESTCFG_CLI_CONFIG as string;
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o600);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.serverUrl).toBe('https://example.test');
    expect(raw.token).toBe('tok_abc');
    const loaded = await loadCliConfig(context);
    expect(loaded).toEqual({
      serverUrl: 'https://example.test',
      token: 'tok_abc',
    });
  });

  it('missing file → empty config', async () => {
    await rm(process.env.TESTCFG_CLI_CONFIG as string, { force: true });
    expect(await loadCliConfig(context)).toEqual({});
  });

  it('config dir is created with 0o700 perms — #1311 A1', async () => {
    if (process.platform === 'win32') return; // unix-only permission model
    await saveAuth(context, 'https://x', 'tok_1');
    const dir = process.env.TESTCFG_CLI_CONFIG
      ? process.env.TESTCFG_CLI_CONFIG.replace(/\/config\.json$/, '')
      : '';
    const s = await stat(dir);
    expect(s.mode & 0o777).toBe(0o700);
  });

  it('enforces 0o700 on a pre-existing 0o755 config dir — #1311 review #4', async () => {
    if (process.platform === 'win32') return;
    const { mkdir, chmod, stat } = await import('node:fs/promises');
    const dir = (process.env.TESTCFG_CLI_CONFIG as string).replace(
      /\/config\.json$/,
      '',
    );
    // Pre-create the dir at world-traversable 0o755 (simulating a legacy
    // install). saveCliConfig should chmod it down to 0o700.
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    await saveAuth(context, 'https://x', 'tok');
    const s = await stat(dir);
    expect(s.mode & 0o777).toBe(0o700);
  });

  it('writes config atomically via tempfile + rename — #1311 review #3', async () => {
    if (process.platform === 'win32') return;
    const { readdir } = await import('node:fs/promises');
    await saveAuth(context, 'https://x', 'tok_abc');
    const dir = (process.env.TESTCFG_CLI_CONFIG as string).replace(
      /\/config\.json$/,
      '',
    );
    // After a successful save, only `config.json` should exist — no
    // leftover `config.json.*.tmp` siblings.
    const entries = await readdir(dir);
    expect(entries).toEqual(['config.json']);
  });

  it('clearStoredToken removes the token but keeps serverUrl', async () => {
    await saveAuth(context, 'https://x', 'tok_1');
    await clearStoredToken(context);
    expect(await loadCliConfig(context)).toEqual({
      serverUrl: 'https://x',
    });
  });
});

describe('env var precedence', () => {
  it('env > config > defaultServerUrl', async () => {
    await saveAuth(context, 'https://from-config', 'tok_cfg');
    process.env.TESTCFG_SERVER_URL = 'https://from-env';
    expect(await getServerUrl(context)).toBe('https://from-env');
    delete process.env.TESTCFG_SERVER_URL;
    expect(await getServerUrl(context)).toBe('https://from-config');
  });

  it('falls back to defaultServerUrl when neither env nor config set', async () => {
    expect(await getServerUrl(context)).toBe('https://default.example');
  });

  it('env token wins over config token', async () => {
    await saveAuth(context, 'https://x', 'tok_cfg');
    process.env.TESTCFG_TOKEN = 'tok_env';
    expect(await getStoredToken(context)).toBe('tok_env');
  });
});

describe('requestJson', () => {
  it('attaches bearer when token present', async () => {
    await saveAuth(context, 'https://api.example', 'tok_abc');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Headers).get('authorization')).toBe(
        'Bearer tok_abc',
      );
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const r = await requestJson(
      context,
      '/test',
      { method: 'GET' },
      { fetch: fetchMock as any },
    );
    expect(r).toEqual({ ok: true });
  });

  it('throws on 401 with server error message', async () => {
    await saveAuth(context, 'https://api.example', 'tok_abc');
    const fetchMock = vi.fn(
      async () =>
        new Response('{"error":"unauthenticated"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      requestJson(
        context,
        '/test',
        { method: 'GET' },
        { fetch: fetchMock as any },
      ),
    ).rejects.toThrow(/unauthenticated/);
  });

  it('requireAuth throws before fetch when no token', async () => {
    const fetchMock = vi.fn();
    await expect(
      requestJson(
        context,
        '/x',
        { method: 'GET' },
        { fetch: fetchMock as any, requireAuth: true },
      ),
    ).rejects.toThrow(/Not authenticated/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
