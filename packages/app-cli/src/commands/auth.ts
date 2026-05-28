/**
 * `<name> auth login | status | logout` — terminal device-code flow against
 * `/api/cli/auth/start` and `/api/cli/auth/token` (shipped by smrt-users).
 *
 * @packageDocumentation
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  type CliConfigContext,
  clearStoredToken,
  getServerUrl,
  getStoredToken,
  loadCliConfig,
  requestJson,
  saveAuth,
} from '../config.js';

interface AuthStartResponse {
  deviceCode: string;
  expiresAt: string;
  interval?: number;
  userCode: string;
  verificationUrl: string;
}

interface AuthTokenResponse {
  accessToken?: string;
  expiresIn?: number;
  interval?: number;
  status: 'approved' | 'expired' | 'pending';
  tokenType?: 'Bearer';
}

interface AuthSessionResponse extends Record<string, unknown> {
  authenticated: boolean;
}

export interface AuthCommandsOptions {
  context: CliConfigContext;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  /** Skip auto-opening the browser; tests pass true. */
  noOpenDefault?: boolean;
  /** Override the polling sleep (tests pass 0). */
  sleepMs?: (ms: number) => Promise<void>;
}

export async function runAuthLogin(
  options: AuthCommandsOptions,
  args: string[],
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const sleep =
    options.sleepMs ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const { noOpen, serverUrl } = parseAuthLoginArgs(args, options.noOpenDefault);
  const targetServer = (
    serverUrl ?? (await getServerUrl(options.context))
  ).replace(/\/+$/u, '');

  const start = await requestJson<AuthStartResponse>(
    options.context,
    '/api/cli/auth/start',
    { method: 'POST' },
    { auth: false, serverUrl: targetServer },
  );

  stdout.write(`Open ${start.verificationUrl}\n`);
  stdout.write(`Code: ${start.userCode}\n`);
  if (!noOpen) openVerificationUrl(start.verificationUrl);

  const expiresAt = new Date(start.expiresAt).getTime();
  let interval = start.interval ?? 2;

  while (Date.now() < expiresAt) {
    await sleep(interval * 1000);
    try {
      const token = await requestJson<AuthTokenResponse>(
        options.context,
        '/api/cli/auth/token',
        {
          body: JSON.stringify({ deviceCode: start.deviceCode }),
          method: 'POST',
        },
        { auth: false, serverUrl: targetServer },
      );

      if (token.status === 'approved' && token.accessToken) {
        await saveAuth(options.context, targetServer, token.accessToken);
        stdout.write(`Authenticated to ${targetServer}\n`);
        return;
      }
      if (token.status === 'expired') break;
      interval = token.interval ?? interval;
    } catch (error) {
      if (error instanceof Error && error.message.includes('HTTP 410')) break;
      throw error;
    }
  }

  throw new Error('Terminal login request expired.');
}

export async function runAuthStatus(
  options: AuthCommandsOptions,
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const config = await loadCliConfig(options.context);
  const serverUrl = await getServerUrl(options.context, config);
  const token = await getStoredToken(options.context, config);
  if (!token) {
    stdout.write(
      `${JSON.stringify({ authenticated: false, serverUrl }, null, 2)}\n`,
    );
    return;
  }

  try {
    const session = await requestJson<AuthSessionResponse>(
      options.context,
      '/api/cli/auth/session',
      { method: 'GET' },
    );
    stdout.write(`${JSON.stringify({ ...session, serverUrl }, null, 2)}\n`);
  } catch (error) {
    stdout.write(
      `${JSON.stringify(
        {
          authenticated: false,
          serverUrl,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      )}\n`,
    );
  }
}

export async function runAuthLogout(
  options: AuthCommandsOptions,
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  try {
    await requestJson(options.context, '/api/cli/auth/session', {
      method: 'DELETE',
    });
  } catch {
    // Best effort — local logout still proceeds.
  }
  await clearStoredToken(options.context);
  stdout.write(`${JSON.stringify({ authenticated: false }, null, 2)}\n`);
}

/* ── argv ─────────────────────────────────────────────────────────────── */

function parseAuthLoginArgs(
  args: string[],
  noOpenDefault = false,
): { noOpen: boolean; serverUrl?: string } {
  const result: { noOpen: boolean; serverUrl?: string } = {
    noOpen: noOpenDefault,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-open') {
      result.noOpen = true;
    } else if (arg === '--server') {
      result.serverUrl = args[i + 1];
      i += 1;
    } else if (arg?.startsWith('--server=')) {
      result.serverUrl = arg.slice('--server='.length);
    } else {
      throw new Error(`Unknown auth login option: ${arg}`);
    }
  }
  return result;
}

function commandExists(cmd: string): boolean {
  if (process.platform === 'win32') return true;
  return (
    spawnSync('sh', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' })
      .status === 0
  );
}

function openVerificationUrl(url: string): void {
  const candidates: Array<{ args: string[]; command: string }> =
    process.platform === 'darwin'
      ? [{ args: [url], command: 'open' }]
      : process.platform === 'win32'
        ? [{ args: [url], command: 'explorer.exe' }]
        : [
            { args: [url], command: 'xdg-open' },
            { args: ['open', url], command: 'gio' },
          ];
  const opener = candidates.find((c) => commandExists(c.command));
  if (!opener) return;
  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => undefined);
  child.unref();
}
