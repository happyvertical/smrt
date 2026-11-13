/**
 * The assistant-plugin launcher: find the running desktop app, check it is
 * alive, take a local MCP token from app-runtime's own store, and run the
 * app's bundled `smrt-mcp-bridge` with stdio forwarded until either side
 * goes away. Everything it needs from the app is app-runtime's: the origin
 * file the running app writes, and the token store. Nothing here is a second
 * credential system.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import {
  openLocalMcpTokenStore,
  readOriginFile,
  resolveApplicationStateRoot,
} from '@happyvertical/smrt-app-runtime';
import { loopbackStatus } from './loopback.js';
import { SecretRedactor } from './redact.js';

/**
 * Failure classes, each with one distinct exit code and one fixed stderr line.
 * Exit codes are part of the contract.
 */
export const LAUNCHER_FAILURES = Object.freeze({
  origin_unavailable: {
    exitCode: 10,
    message:
      'The desktop app is not running. Open the desktop app and try again.',
  },
  unhealthy: {
    exitCode: 11,
    message:
      'The desktop app did not answer its health check. Restart the desktop app.',
  },
  token_unavailable: {
    exitCode: 12,
    message:
      'No assistant credential could be issued. Open the desktop app, sign in, and try again.',
  },
  bridge_start_failed: {
    exitCode: 13,
    message:
      'The bundled MCP bridge could not be started. Reinstall the desktop app.',
  },
  bridge_exited: {
    exitCode: 14,
    message: 'The bundled MCP bridge stopped unexpectedly.',
  },
  invalid_options: {
    exitCode: 15,
    message:
      'The launcher is not configured correctly. Reinstall the desktop app.',
  },
});

export type LauncherFailureCode = keyof typeof LAUNCHER_FAILURES;

/** Options for {@link runLauncher}. */
export interface RunLauncherOptions {
  /** Product id; the token holder is `plugin-launcher:<productId>`. */
  readonly productId: string;
  /** The app's id, data directory and source root, as the app itself uses. */
  readonly appId: string;
  readonly dataDirectory: string;
  readonly sourceRoot: string;
  /** Absolute resource root: the bridge's working directory. */
  readonly resourceRoot: string;
  /** Absolute paths, inside `resourceRoot`, to the bundled Node and bridge. */
  readonly nodePath: string;
  readonly bridgePath: string;
  /** The sidecar manifest's `healthRoute`, probed with GET (2xx required). */
  readonly healthRoute: string;
  /** Bridge env prefix: `<P>_SERVER_URL`, `<P>_TOKEN`, `<P>_CLI_CONFIG`. */
  readonly envPrefix: string;
  /** Permission slugs the token carries. */
  readonly scopes: readonly string[];
  /** Private CLI config issued by the app. Reuse this credential; never remint on launch. */
  readonly credentialPath?: string;
  /** Bridge `--mcp-path`, `--name` and `--version`. */
  readonly mcpPath?: string;
  readonly serverName?: string;
  readonly serverVersion?: string;
  /** Default `process.stdin`, `process.stdout`, `process.stderr`. */
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  /** Health probe budget. Default 5 000 ms. */
  readonly probeTimeoutMs?: number;
  /** Wait after stdin closes, then again after SIGTERM. Default 5 000 ms. */
  readonly shutdownGraceMs?: number;
  /**
   * Test seam only: replaces the real token-store call
   * (`openLocalMcpTokenStore(...).issue({ holder, scopes })`).
   */
  readonly issueToken?: (request: {
    holder: string;
    scopes: readonly string[];
  }) => Promise<string>;
}

class Failure extends Error {
  constructor(readonly code: LauncherFailureCode) {
    super(code);
  }
}

const ENV_PREFIX = /^[A-Z][A-Z0-9_]{0,63}$/u;
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const ROUTE = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?$/u;
/** Characters no JSON or URL encoding changes, so exact-byte redaction holds. */
const TOKEN = /^[A-Za-z0-9._~-]{16,512}$/u;
const FLUSH_MS = 2_000;
const SIGNAL_NUMBER: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};

/** Reject a malformed option or a binary outside the resource root. */
async function validate(o: RunLauncherOptions): Promise<void> {
  const paths = [
    o.dataDirectory,
    o.sourceRoot,
    o.resourceRoot,
    o.nodePath,
    o.bridgePath,
    ...(o.credentialPath === undefined ? [] : [o.credentialPath]),
  ];
  const ok =
    typeof o.appId === 'string' &&
    PRODUCT_ID.test(o.productId) &&
    ENV_PREFIX.test(o.envPrefix) &&
    ROUTE.test(o.healthRoute) &&
    !o.healthRoute.split('/').includes('..') &&
    Array.isArray(o.scopes) &&
    o.scopes.length > 0 &&
    paths.every(
      (p) => typeof p === 'string' && !p.includes('\0') && isAbsolute(p),
    ) &&
    (o.mcpPath === undefined || /^\/[^\s\\?#%]*$/u.test(o.mcpPath)) &&
    [o.serverName, o.serverVersion].every(
      (v) => v === undefined || IDENTITY.test(v),
    );
  if (!ok) throw new Failure('invalid_options');
  try {
    // Contained and reached without a symlink out of the root. PATH is never
    // consulted: both paths are absolute.
    const root = await realpath(o.resourceRoot);
    for (const path of [o.nodePath, o.bridgePath]) {
      const inside = relative(root, await realpath(path));
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
        throw new Failure('invalid_options');
      }
    }
  } catch {
    throw new Failure('invalid_options');
  }
}

async function defaultIssueToken(
  o: RunLauncherOptions,
  request: { holder: string; scopes: readonly string[] },
): Promise<string> {
  const store = await openLocalMcpTokenStore({
    appId: o.appId,
    dataDirectory: o.dataDirectory,
    sourceRoot: o.sourceRoot,
  });
  try {
    if (o.credentialPath) {
      const file = await open(
        o.credentialPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > 16_384 ||
          (process.platform !== 'win32' &&
            ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
        )
          throw new Failure('token_unavailable');
        const config = JSON.parse(await file.readFile('utf8'));
        const token = config.token;
        const principal =
          typeof token === 'string' ? await store.verify(token) : null;
        if (
          !principal ||
          !o.scopes.every((scope) => principal.scopes.includes(scope))
        )
          throw new Failure('token_unavailable');
        return token;
      } finally {
        await file.close();
      }
    }
    return (await store.issue(request)).token;
  } finally {
    await store.close().catch(() => undefined);
  }
}

/**
 * Run one launch. Resolves with the process exit code and never calls
 * `process.exit`, so output can drain: set `process.exitCode` from it. A
 * failure writes one fixed line to stderr; no path, origin, token or provider
 * message is ever part of it.
 */
export async function runLauncher(o: RunLauncherOptions): Promise<number> {
  const stderr = o.stderr ?? process.stderr;
  try {
    return await launch(o);
  } catch (error) {
    const code: LauncherFailureCode =
      error instanceof Failure ? error.code : 'invalid_options';
    try {
      stderr.write(
        `smrt-desktop-launcher: ${code}: ${LAUNCHER_FAILURES[code].message}\n`,
      );
    } catch {
      // Nothing can be done about a broken stderr.
    }
    return LAUNCHER_FAILURES[code].exitCode;
  }
}

async function launch(o: RunLauncherOptions): Promise<number> {
  await validate(o);

  // The running app's own record; null for absent, stale, or any origin other
  // than exactly http://127.0.0.1:<port>.
  const record = await readOriginFile(
    resolveApplicationStateRoot({
      appId: o.appId,
      dataDirectory: o.dataDirectory,
      sourceRoot: o.sourceRoot,
    }),
  ).catch(() => null);
  if (!record) throw new Failure('origin_unavailable');

  const status = await loopbackStatus(
    Number(new URL(record.origin).port),
    o.healthRoute,
    o.probeTimeoutMs ?? 5_000,
  ).catch(() => 0);
  if (status < 200 || status > 299) throw new Failure('unhealthy');

  // Only a live, healthy instance causes a token to be issued.
  let token: unknown;
  try {
    const request = {
      holder: `plugin-launcher:${o.productId}`,
      scopes: o.scopes,
    };
    token = await (o.issueToken
      ? o.issueToken(request)
      : defaultIssueToken(o, request));
  } catch {
    throw new Failure('token_unavailable');
  }
  if (typeof token !== 'string' || !TOKEN.test(token)) {
    throw new Failure('token_unavailable');
  }
  return supervise(o, record.origin, token);
}

const alive = (child: ChildProcess) =>
  child.exitCode === null && child.signalCode === null;

async function supervise(
  o: RunLauncherOptions,
  origin: string,
  token: string,
): Promise<number> {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  const stderr = o.stderr ?? process.stderr;
  const graceMs = o.shutdownGraceMs ?? 5_000;

  // Built from scratch: nothing ambient (PATH, NODE_OPTIONS, proxies) is
  // inherited, and the token travels only here, never in argv.
  const env: NodeJS.ProcessEnv = {
    [`${o.envPrefix}_SERVER_URL`]: origin,
    [`${o.envPrefix}_TOKEN`]: token,
    [`${o.envPrefix}_CLI_CONFIG`]: devNull,
    ...(process.platform === 'win32' && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
  const args = [
    o.bridgePath,
    `--env-prefix=${o.envPrefix}`,
    `--mcp-path=${o.mcpPath ?? '/api/mcp'}`,
    ...(o.serverName ? [`--name=${o.serverName}`] : []),
    ...(o.serverVersion ? [`--version=${o.serverVersion}`] : []),
  ];

  let child: ChildProcess;
  try {
    child = spawn(o.nodePath, args, {
      cwd: o.resourceRoot,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    throw new Failure('bridge_start_failed');
  }
  const started = await new Promise<boolean>((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  if (!started) throw new Failure('bridge_start_failed');
  child.on('error', () => undefined);

  const childIn = child.stdin as Writable;
  const redactOut = new SecretRedactor(token);
  const redactErr = new SecretRedactor(token);
  let stopping = false;
  let signalled: NodeJS.Signals | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  /** Stop forwarding, ask the bridge to stop, escalate to SIGKILL. */
  const stop = () => {
    if (stopping) return;
    stopping = true;
    stdin.unpipe(childIn);
    childIn.end();
    if (alive(child)) child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (alive(child)) child.kill('SIGKILL');
    }, graceMs);
  };
  // The host closing stdin lets the bridge see EOF and exit by itself;
  // escalate if it does not.
  const onStdinGone = () => {
    graceTimer ??= setTimeout(stop, graceMs);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    signalled ??= signal;
    stop();
  };
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  const handlers = signals.map((s) => [s, () => onSignal(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);
  childIn.on('error', () => undefined);
  stdout.on('error', stop);
  stderr.on('error', stop);
  stdin.on('end', onStdinGone);
  stdin.on('close', onStdinGone);

  // pipe() carries the backpressure in both directions.
  stdin.pipe(childIn);
  child.stdout?.pipe(redactOut).pipe(stdout, { end: false });
  child.stderr?.pipe(redactErr).pipe(stderr, { end: false });

  const code = await new Promise<number | null>((resolve) => {
    child.once('exit', (exitCode) => resolve(exitCode));
  });
  try {
    // Let the last output reach the host, but never wait on a stalled host
    // or on a stray process holding the bridge's pipes open.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(
        [redactOut, redactErr].map((r) => finished(r).catch(() => undefined)),
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FLUSH_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  } finally {
    clearTimeout(graceTimer);
    clearTimeout(killTimer);
    for (const [s, h] of handlers) process.off(s, h);
    stdin.off('end', onStdinGone);
    stdin.off('close', onStdinGone);
    stdin.unpipe(childIn);
    stdin.pause();
    child.stdout?.destroy();
    child.stderr?.destroy();
    redactOut.destroy();
    redactErr.destroy();
    stdout.off('error', stop);
    stderr.off('error', stop);
    // A late write error must not become an uncaught exception.
    stdout.on('error', () => undefined);
    stderr.on('error', () => undefined);
  }

  if (signalled) return 128 + (SIGNAL_NUMBER[signalled] ?? 15);
  if (stopping || code === 0) return 0;
  throw new Failure('bridge_exited');
}
