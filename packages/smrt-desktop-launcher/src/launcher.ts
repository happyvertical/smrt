/**
 * The launcher core: resolve, connect, hand over the credential, then run the
 * bundled MCP bridge with stdio forwarded until either side goes away.
 *
 * @packageDocumentation
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { devNull } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import {
  DIAGNOSTICS,
  type DiagnosticCode,
  EXIT_OK,
  formatDiagnostic,
  signalExitCode,
} from './diagnostics.js';
import {
  PROBE_TIMEOUT_MS,
  probeCredential,
  probeHealth,
  validateOrigin,
} from './endpoint.js';
import { LauncherFailure } from './failure.js';
import {
  type InstalledRuntime,
  type LauncherCredential,
  type LauncherProvider,
  LauncherProviderError,
  type ProviderContext,
} from './provider.js';
import { SecretRedactor } from './redact.js';
import { validateInstall, verifyRuntimeFiles } from './trust.js';

/** Minimal signal source; `process` satisfies it. Injectable for tests. */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface RunLauncherOptions {
  /** The shell integration. See {@link LauncherProvider}. */
  readonly provider: LauncherProvider;
  /** The product this launcher was generated for. */
  readonly productId: string;
  /** Prefix of the stderr diagnostic line. Default `smrt-desktop-launcher`. */
  readonly name?: string;
  /** Host side of the MCP stdio connection. Default `process.stdin`. */
  readonly stdin?: Readable;
  /** Default `process.stdout`. Only bridge output is ever written to it. */
  readonly stdout?: Writable;
  /** Default `process.stderr`. Diagnostics and redacted bridge stderr. */
  readonly stderr?: Writable;
  /** Default `process`. */
  readonly signals?: SignalSource;
  /** Used for the health and credential probes. Default global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Provider contract versions accepted. Default `[1]`. */
  readonly supportedContracts?: readonly number[];
  /** Budget for each provider method. Default 30 000 ms. */
  readonly providerTimeoutMs?: number;
  /** Budget for each probe request. Default 5 000 ms. */
  readonly probeTimeoutMs?: number;
  /** SIGTERM-to-SIGKILL grace, and the wait after stdin closes. Default 5 000 ms. */
  readonly shutdownGraceMs?: number;
  /**
   * After the bridge exits, how long to wait for its remaining output to reach
   * the host before abandoning it (a stalled host, or a stray process holding
   * the bridge's pipes open). Default 2 000 ms.
   */
  readonly outputFlushTimeoutMs?: number;
}

const SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const DEFAULT_NAME = 'smrt-desktop-launcher';
/**
 * Credential characters that no JSON or URL encoding changes, so the exact-byte
 * redactor also covers an encoded copy of the credential.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/u;
const DEFAULT_FLUSH_MS = 2_000;

/**
 * Run one launch. Resolves with the process exit code; never calls
 * `process.exit`, so output can drain. Set `process.exitCode` from the result.
 */
export async function runLauncher(
  options: RunLauncherOptions,
): Promise<number> {
  const name = options.name ?? DEFAULT_NAME;
  const stderr = options.stderr ?? process.stderr;
  const signals = options.signals ?? process;
  const lifecycle = new AbortController();
  let signalled: NodeJS.Signals | undefined;
  let killChild: (() => void) | undefined;

  const handlers = SIGNALS.map((signal) => {
    const handler = () => {
      if (signalled) {
        // A second signal means: stop waiting.
        killChild?.();
        return;
      }
      signalled = signal;
      lifecycle.abort();
    };
    signals.on(signal, handler);
    return [signal, handler] as const;
  });

  try {
    return await launch(
      options,
      lifecycle.signal,
      (kill) => {
        killChild = kill;
      },
      () => signalled,
    );
  } catch (error) {
    if (signalled) return signalExitCode(signalled);
    const code: DiagnosticCode =
      error instanceof LauncherFailure ? error.code : 'internal';
    return diagnose(stderr, name, code);
  } finally {
    for (const [signal, handler] of handlers) signals.off(signal, handler);
  }
}

function diagnose(
  stderr: Writable,
  name: string,
  code: DiagnosticCode,
): number {
  try {
    stderr.write(formatDiagnostic(name, code));
  } catch {
    // Nothing else can be done about a broken stderr.
  }
  return codeToExit(code);
}

function codeToExit(code: DiagnosticCode): number {
  return DIAGNOSTICS_EXIT[code];
}

const DIAGNOSTICS_EXIT = Object.fromEntries(
  Object.entries(DIAGNOSTICS).map(([key, value]) => [key, value.exitCode]),
) as Record<DiagnosticCode, number>;

/**
 * Run a provider method under a time budget and the shutdown signal. Provider
 * failures keep their code; anything else is `internal`; a timeout or
 * shutdown yields the phase's own code.
 */
async function callProvider<T>(
  options: RunLauncherOptions,
  shutdown: AbortSignal,
  onTimeout: DiagnosticCode,
  run: (context: ProviderContext) => Promise<T> | T,
  onLate?: (value: T) => void,
): Promise<T> {
  const signal = AbortSignal.any([
    shutdown,
    AbortSignal.timeout(options.providerTimeoutMs ?? 30_000),
  ]);
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new LauncherFailure(onTimeout));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  const work = Promise.resolve().then(() => run({ signal }));
  try {
    return await Promise.race([work, aborted]);
  } catch (error) {
    // A value that arrives after we gave up still needs its owner told.
    if (onLate) work.then(onLate, () => undefined);
    if (error instanceof LauncherFailure) throw error;
    if (LauncherProviderError.is(error)) throw new LauncherFailure(error.code);
    throw new LauncherFailure('internal');
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

function checkpoint(shutdown: AbortSignal): void {
  // The caller maps this to the signal exit status.
  if (shutdown.aborted) throw new LauncherFailure('internal');
}

async function launch(
  options: RunLauncherOptions,
  shutdown: AbortSignal,
  setKill: (kill: () => void) => void,
  getSignal: () => NodeJS.Signals | undefined,
): Promise<number> {
  const probeTimeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;
  const { provider, productId } = options;

  const install = validateInstall(
    await callProvider(options, shutdown, 'missing_install', (context) =>
      provider.resolveInstall({ productId }, context),
    ),
    { productId, supportedContracts: options.supportedContracts ?? [1] },
  );
  checkpoint(shutdown);
  await verifyRuntimeFiles(install);
  checkpoint(shutdown);

  const origin = validateOrigin(
    await callProvider(options, shutdown, 'stale_instance', (context) =>
      provider.connectInstance(install, context),
    ),
  );
  checkpoint(shutdown);
  await probeHealth(fetchImpl, origin, install, shutdown, probeTimeout);
  checkpoint(shutdown);

  // The credential is requested only after the runtime and the endpoint are
  // trusted, so a bad install or a wrong endpoint never causes a handoff.
  const credential = await callProvider(
    options,
    shutdown,
    'credential_unavailable',
    (context) => provider.acquireCredential(install, { origin }, context),
    (late) => void releaseOnce(late)(),
  );
  const release = releaseOnce(credential);
  try {
    const token = readToken(credential);
    checkpoint(shutdown);
    await probeCredential(
      fetchImpl,
      origin,
      install,
      token,
      shutdown,
      probeTimeout,
    );
    checkpoint(shutdown);
    // Re-check as late as possible to narrow the check-to-spawn window, and
    // run the canonical paths it verified rather than the ones supplied.
    const verified = await verifyRuntimeFiles(install);
    checkpoint(shutdown);
    return await supervise(
      options,
      { ...install, ...verified },
      origin,
      token,
      shutdown,
      setKill,
      getSignal,
      release,
    );
  } finally {
    await release();
  }
}

/** A `release()` that runs the credential's hook at most once and never throws. */
function releaseOnce(
  credential: LauncherCredential | undefined,
): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    try {
      await credential?.release?.();
    } catch {
      // Custody cleanup failing must not change the launch outcome.
    }
  };
}

function readToken(credential: LauncherCredential | undefined): string {
  const token = (credential as Partial<LauncherCredential> | undefined)?.token;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new LauncherFailure('credential_invalid');
  }
  return token;
}

/**
 * The child environment is built from scratch: nothing ambient is inherited
 * (no `PATH`, `NODE_OPTIONS`, proxies or unrelated secrets). The credential
 * travels only here, never in argv.
 */
function childEnvironment(
  install: InstalledRuntime,
  origin: string,
  token: string,
): NodeJS.ProcessEnv {
  const prefix = install.envPrefix;
  return {
    [`${prefix}_SERVER_URL`]: origin,
    [`${prefix}_TOKEN`]: token,
    // The bridge reads no ambient config file.
    [`${prefix}_CLI_CONFIG`]: devNull,
    ...(process.platform === 'win32' && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
}

function bridgeArguments(install: InstalledRuntime): string[] {
  return [
    install.bridgePath,
    `--env-prefix=${install.envPrefix}`,
    `--mcp-path=${install.mcpPath ?? '/api/mcp'}`,
    ...(install.serverName ? [`--name=${install.serverName}`] : []),
    ...(install.serverVersion ? [`--version=${install.serverVersion}`] : []),
  ];
}

function ignoreError(): void {}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function supervise(
  options: RunLauncherOptions,
  install: InstalledRuntime,
  origin: string,
  token: string,
  shutdown: AbortSignal,
  setKill: (kill: () => void) => void,
  getSignal: () => NodeJS.Signals | undefined,
  release: () => Promise<void>,
): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const name = options.name ?? DEFAULT_NAME;
  const graceMs = options.shutdownGraceMs ?? 5_000;

  let child: ChildProcess;
  try {
    child = spawn(install.nodePath, bridgeArguments(install), {
      cwd: install.root,
      env: childEnvironment(install, origin, token),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    // spawn() throws synchronously for some failures (e.g. ENOEXEC).
    throw new LauncherFailure('bridge_start_failed');
  }

  const started = await new Promise<boolean>((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  if (!started) throw new LauncherFailure('bridge_start_failed');
  child.on('error', () => undefined);
  // The bridge holds the credential now; custody may drop its handoff.
  void release();

  const childIn = child.stdin as Writable;
  const redactOut = new SecretRedactor(token);
  const redactErr = new SecretRedactor(token);
  let terminating = false;
  let terminatedByUs = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let pipeTimer: NodeJS.Timeout | undefined;

  const flushMs = options.outputFlushTimeoutMs ?? DEFAULT_FLUSH_MS;
  const sigkill = () => {
    if (alive(child)) child.kill('SIGKILL');
  };
  /** Stop moving bridge output; whatever has not reached the host is dropped. */
  const abandonOutput = () => {
    child.stdout?.unpipe();
    child.stderr?.unpipe();
    redactOut.destroy();
    redactErr.destroy();
  };
  // A second signal means: stop waiting for anything.
  setKill(() => {
    sigkill();
    abandonOutput();
  });

  /** Stop forwarding, ask the bridge to stop, escalate to SIGKILL. */
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    terminatedByUs = true;
    stdin.unpipe(childIn);
    childIn.end();
    if (alive(child)) child.kill('SIGTERM');
    killTimer = setTimeout(sigkill, graceMs);
  };

  const onStdinGone = () => {
    // The host closed the connection: the bridge sees EOF through the pipe
    // and should exit by itself; escalate if it does not.
    if (terminating || graceTimer) return;
    graceTimer = setTimeout(terminate, graceMs);
  };
  const onOutputError = () => {
    // The host is gone (e.g. EPIPE): nothing can be forwarded any more.
    abandonOutput();
    terminate();
  };

  childIn.on('error', () => undefined);
  stdout.on('error', onOutputError);
  stderr.on('error', onOutputError);
  stdin.on('end', onStdinGone);
  stdin.on('close', onStdinGone);
  shutdown.addEventListener('abort', terminate, { once: true });

  // pipe() provides the backpressure in both directions: a slow host pauses
  // the bridge's output, and a slow bridge pauses the host's input.
  stdin.pipe(childIn);
  child.stdout?.pipe(redactOut).pipe(stdout, { end: false });
  child.stderr?.pipe(redactErr).pipe(stderr, { end: false });

  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', () => {
      // A stray process holding the bridge's pipes open must not hold the
      // launcher: cut them and let the redactors finish with what they have.
      pipeTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        redactOut.end();
        redactErr.end();
      }, flushMs);
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  if (shutdown.aborted) terminate();

  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await closed;
    // Let the last output reach the host, but never wait on a stalled host.
    let flushTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([
        finished(redactOut).catch(() => undefined),
        finished(redactErr).catch(() => undefined),
      ]),
      new Promise<void>((resolve) => {
        flushTimer = setTimeout(resolve, flushMs);
      }),
    ]).finally(() => clearTimeout(flushTimer));
  } finally {
    abandonOutput();
    clearTimeout(graceTimer);
    clearTimeout(killTimer);
    clearTimeout(pipeTimer);
    shutdown.removeEventListener('abort', terminate);
    stdin.off('end', onStdinGone);
    stdin.off('close', onStdinGone);
    stdin.unpipe(childIn);
    stdin.pause();
    // A late write error on the host's stream must not become an uncaught
    // exception once nobody is listening.
    stdout.off('error', onOutputError);
    stderr.off('error', onOutputError);
    stdout.on('error', ignoreError);
    stderr.on('error', ignoreError);
    sigkill();
  }

  const signal = getSignal();
  if (signal) return signalExitCode(signal);
  if (terminatedByUs || exit.code === 0) return EXIT_OK;
  try {
    stderr.write(formatDiagnostic(name, 'bridge_exited'));
  } catch {
    // stderr is gone.
  }
  return DIAGNOSTICS_EXIT.bridge_exited;
}
