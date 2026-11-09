import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { DesktopContractError } from '../errors.js';
import type { VerifiedInstallation } from '../install/locate.js';
import {
  type DesktopFs,
  FsTrustError,
  nodeFs,
  type StatsLike,
} from '../internal/fs-seam.js';
import {
  assertPrivateDirectory,
  type FileCustodyOptions,
  readPrivateFile,
} from '../internal/private-file.js';
import {
  type ControlResponse,
  type InstanceStateResponse,
  MAX_ENSURE_READY_TIMEOUT_MS,
} from './control-protocol.js';
import { sendControlRequest } from './control-transport.js';
import { type ControlEndpoint, controlSocketDirectory } from './endpoint.js';
import type { RendezvousFailureCode } from './failure-code.js';
import {
  INSTANCE_RECORD_FILENAME,
  type InstanceRecordV1,
  parseInstanceRecord,
} from './instance-record.js';
import { issueVettedEndpoint, type VettedEndpoint } from './vetted-endpoint.js';

/** The non-secret flag that starts the shell without showing a window. */
export const SHELL_BACKGROUND_FLAG = '--smrt-background';

/** Default `ensureReady` budget: a cold start plus migrations. */
export const DEFAULT_ENSURE_READY_TIMEOUT_MS = 60_000;

/**
 * Outcome of `status` and `ensureReady`. It carries an origin and a
 * non-secret instance nonce, never a bearer, a pid or a path.
 *
 * - `ready`: the control channel answered for the recorded instance and
 *   reported `ready`. `origin` is exactly `http://127.0.0.1:<port>`. `endpoint`
 *   is the vetted channel handle (see `RendezvousResult` below).
 * - `starting`: (`status` only) the instance is up and not ready yet.
 * - `failed`: the instance, or this client, failed with a typed `code`. A
 *   `failed` outcome is returned, never retried by the client.
 * - `not_installed`: the installed product could not be found.
 * - `not_running`: no live instance (`status`, or `ensureReady` with
 *   `start: false`).
 * - `untrusted_state`: the installation, record, directory or socket failed a
 *   custody check. Nothing was started.
 * - `unresponsive`: something holds the control endpoint (it accepted the
 *   connection, or timed out) but gave no usable answer, for example a
 *   saturated server dropping connections. Its state is unknown, so nothing
 *   was started; try again later. It is never a stale endpoint.
 * - `timeout`: not ready within the budget (a shell may still be starting).
 */
export type RendezvousResult =
  | {
      readonly state: 'ready';
      readonly origin: string;
      readonly instanceNonce: string;
      readonly productId: string;
      /**
       * The control endpoint the rendezvous vetted, for the credential flow
       * (`createControlChannelSend`). Opaque: no path, no name. Absent on
       * Windows unless the shell supplied `vetPipe`: this package cannot
       * check a pipe's owner or DACL, so without a vetting function there is
       * no handle and the credential flow fails closed.
       */
      readonly endpoint?: VettedEndpoint;
    }
  | { readonly state: 'starting'; readonly instanceNonce: string }
  | { readonly state: 'failed'; readonly code: RendezvousFailureCode }
  | { readonly state: 'not_installed' }
  | { readonly state: 'not_running' }
  | { readonly state: 'untrusted_state' }
  | { readonly state: 'unresponsive' }
  | { readonly state: 'timeout' };

/** What `ensureReady` returns: everything except the transient `starting`. */
export type EnsureReadyResult = Exclude<
  RendezvousResult,
  { readonly state: 'starting' }
>;

export interface EnsureReadyOptions {
  /** Abort the wait. `ensureReady` then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** Total budget in milliseconds. Defaults to 60000. */
  readonly timeoutMs?: number;
  /** Start the shell when nothing is running. Defaults to `true`. */
  readonly start?: boolean;
}

export interface SupervisorRendezvous {
  /** Observe only: never starts anything. */
  status(options?: {
    readonly signal?: AbortSignal;
  }): Promise<RendezvousResult>;
  /**
   * Resolve once the supervisor is `ready` or `failed`, starting the shell
   * (at most once per call) when `start` is true and no instance is running.
   */
  ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult>;
}

/** The command the client runs to start the shell. */
export interface ShellLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Allowlisted variables only; never the launcher's environment wholesale. */
  readonly env: Readonly<Record<string, string>>;
}

export interface RendezvousClock {
  now(): number;
  /** Resolve after `ms`; reject with the signal's reason when aborted. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** `lstat` must report socket-ness so the endpoint can be vetted. */
export interface RendezvousFs extends DesktopFs {
  lstat(path: string): Promise<StatsLike & { isSocket(): boolean }>;
}

export interface FileRendezvousOptions {
  /**
   * Contract (a): find and verify the installed product, for example
   * `() => locateInstallation({ productId, bundleId })`. Called once per
   * `status` or `ensureReady` call.
   */
  readonly locate: () => Promise<VerifiedInstallation>;
  /**
   * Start the shell detached and resolve once the process exists. The default
   * spawns `launch.executable` with `detached`, ignored stdio and no shell.
   * The shell's single-instance lock, and behind it the runtime writer lease,
   * are the real exclusion: a duplicate start is forwarded or fails
   * `lease_held`, it never becomes a second writer.
   */
  readonly spawnShell?: (launch: ShellLaunch) => Promise<void>;
  /** Read-only filesystem seam. Defaults to `node:fs/promises`. */
  readonly fs?: RendezvousFs;
  readonly clock?: RendezvousClock;
  /** First poll delay while waiting for a started shell. Default 250. */
  readonly pollIntervalMs?: number;
  /** Poll delay ceiling (delay grows 1.5x per poll). Default 1000. */
  readonly maxPollIntervalMs?: number;
  /** Connect timeout of one control request. Default 1000. */
  readonly connectTimeoutMs?: number;
  /** Response timeout of a `status` request. Default 2000. */
  readonly statusTimeoutMs?: number;
  /**
   * Windows only: the shell's check of a named pipe (the server's owner or
   * process via `GetNamedPipeServerProcessId`, and the DACL). Node cannot do
   * this and this package implements no pipe vetting of its own. Without it a
   * `ready` result on Windows carries no `endpoint` handle (the credential
   * flow then fails closed); a function that returns `false` or throws makes
   * the pipe `untrusted_state`. Ignored on POSIX, where the directory and
   * socket checks are done here.
   */
  readonly vetPipe?: (
    endpoint: Extract<ControlEndpoint, { readonly kind: 'pipe' }>,
  ) => boolean | Promise<boolean>;
  /** Effective uid. Defaults to `process.getuid()`; ignored on Windows. */
  readonly currentUid?: number;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Source of the spawn environment allowlist. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const defaultFs: RendezvousFs = {
  ...nodeFs,
  lstat: (path) => fsp.lstat(path),
};

const defaultClock: RendezvousClock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}

const ENV_ALLOWLIST = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'SystemRoot',
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'LANG',
]);
const ENV_ALLOW_PREFIXES = ['XDG_', 'LC_'];

/** The environment the shell is started with: an allowlist, never wholesale. */
export function shellLaunchEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      ENV_ALLOWLIST.has(key) ||
      ENV_ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      env[key] = value;
    }
  }
  return env;
}

function defaultSpawnShell(launch: ShellLaunch): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(launch.executable, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.env },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    child.on('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

type Probe =
  | {
      readonly kind: 'ready';
      readonly origin: string;
      readonly instanceNonce: string;
      readonly productId: string;
      readonly endpoint: VettedEndpoint | undefined;
    }
  | { readonly kind: 'starting'; readonly instanceNonce: string }
  | { readonly kind: 'failed'; readonly code: RendezvousFailureCode }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unresponsive' }
  | { readonly kind: 'untrusted' };

const ABSENT: Probe = { kind: 'absent' };
const UNRESPONSIVE: Probe = { kind: 'unresponsive' };
const UNTRUSTED: Probe = { kind: 'untrusted' };

/** Delay before re-reading the record after a nonce/origin disagreement. */
const REREAD_DELAY_MS = 50;

function failureOf(code: RendezvousFailureCode): Probe {
  return { kind: 'failed', code };
}

function fromLocateError(error: unknown): RendezvousResult {
  if (error instanceof DesktopContractError) {
    switch (error.code) {
      case 'not_installed':
        return { state: 'not_installed' };
      case 'identity_mismatch':
        return { state: 'failed', code: 'identity_mismatch' };
      case 'unsupported_contract':
        return { state: 'failed', code: 'unsupported_contract' };
      case 'invalid_environment':
      case 'unsupported_platform':
        throw error;
      default:
        return { state: 'untrusted_state' };
    }
  }
  throw error;
}

function frozen<T extends object>(value: T): T {
  return Object.freeze(value);
}

/**
 * Supervisor rendezvous over the instance record and the control channel.
 *
 * `ensureReady`:
 *
 * 1. `locate()` the installed product (contract a). Missing => `not_installed`.
 * 2. Read `instance.json` (private-file rules). Absent => step 5.
 * 3. Vet the endpoint: the private directory, then for a unix socket its
 *    parent directory (real, owned by the user, mode 0700) and the socket
 *    itself (a socket, not a symlink, owned by the user, no group/other bits).
 *    Failure => `untrusted_state`; nothing is started.
 * 4. Ask `status`. Liveness is proven by the channel answering with the
 *    recorded `instanceNonce`: never by the pid, never by the file existing.
 *    No listener (the socket is missing or refuses the connection) => stale =>
 *    step 5. A connection that was accepted and then reset, closed or left
 *    unanswered is NOT stale: the instance may be alive and saturated, so
 *    nothing is started and the call retries `status` until the budget ends
 *    (`unresponsive`). A nonce,
 *    product or origin disagreement is re-read once, then `instance_mismatch`.
 *    `ready` => return. `failed(code)` => return it (never retried, never a
 *    reason to spawn). `starting` => wait on `ensure-ready` for the budget.
 * 5. With `start: false` => `not_running`. Otherwise spawn the shell with
 *    `--smrt-background` once and poll with backoff until `ready`, `failed`,
 *    the budget (`timeout`) or the signal (rejects with its reason).
 *
 * The client is read-only: it never writes, renames or deletes
 * `instance.json`, a socket, a lease or a lock. Exclusion between concurrent
 * launchers belongs to the shell (see `FileRendezvousOptions.spawnShell`).
 */
export function createFileRendezvous(
  options: FileRendezvousOptions,
): SupervisorRendezvous {
  const fs = options.fs ?? defaultFs;
  const clock = options.clock ?? defaultClock;
  const platform = options.platform ?? process.platform;
  const separator = platform === 'win32' ? '\\' : '/';
  const spawnShell = options.spawnShell ?? defaultSpawnShell;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const maxPollIntervalMs = options.maxPollIntervalMs ?? 1000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 1000;
  const statusTimeoutMs = options.statusTimeoutMs ?? 2000;
  const uid = 'currentUid' in options ? options.currentUid : process.getuid?.();
  const custody: FileCustodyOptions = {
    fs,
    platform,
    currentUid: uid,
  };
  const throwIfAborted = (signal: AbortSignal | undefined) => {
    if (signal?.aborted) throw abortReason(signal);
  };

  let launching: Promise<boolean> | undefined;
  /** Share one in-flight spawn between concurrent calls on this object. */
  const launch = (installation: VerifiedInstallation): Promise<boolean> => {
    launching ??= (async () => {
      try {
        await spawnShell({
          executable: installation.shellExecutable,
          args: [SHELL_BACKGROUND_FLAG],
          cwd: installation.installRoot,
          env: shellLaunchEnvironment(options.env ?? process.env),
        });
        return true;
      } catch {
        return false;
      } finally {
        launching = undefined;
      }
    })();
    return launching;
  };

  type Read = { readonly record: InstanceRecordV1 } | { readonly probe: Probe };

  async function readRecord(installation: VerifiedInstallation): Promise<Read> {
    try {
      await assertPrivateDirectory(installation.shellDirectory, custody);
      const text = await readPrivateFile(
        `${installation.shellDirectory}${separator}${INSTANCE_RECORD_FILENAME}`,
        { ...custody, maxBytes: 16 * 1024 },
      );
      const record = parseInstanceRecord(text);
      if (
        record.productId !== installation.bundle.productId ||
        record.bundleId !== installation.bundle.bundleId
      ) {
        return { probe: failureOf('instance_mismatch') };
      }
      return { record };
    } catch (error) {
      if (error instanceof FsTrustError) {
        return { probe: error.kind === 'absent' ? ABSENT : UNTRUSTED };
      }
      if (
        error instanceof DesktopContractError &&
        error.code === 'unsupported_contract'
      ) {
        return { probe: failureOf('unsupported_contract') };
      }
      return { probe: UNTRUSTED };
    }
  }

  /**
   * `'vetted'`, `'unvetted'` (a Windows pipe nobody checked: usable for
   * `status`, never handed to the credential flow), `'stale'` (nothing there)
   * or `'untrusted'`.
   */
  async function vetEndpoint(
    endpoint: ControlEndpoint,
  ): Promise<'vetted' | 'unvetted' | 'stale' | 'untrusted'> {
    if ((endpoint.kind === 'pipe') !== (platform === 'win32')) {
      return 'untrusted';
    }
    if (endpoint.kind === 'pipe') {
      // TypeScript implements no pipe vetting: the name grammar is checked by
      // the parser and that is all. A shell that can check the server's
      // identity and DACL injects it; otherwise there is no vetted handle.
      if (options.vetPipe === undefined) return 'unvetted';
      try {
        return (await options.vetPipe(endpoint)) === true
          ? 'vetted'
          : 'untrusted';
      } catch {
        return 'untrusted';
      }
    }
    try {
      await assertPrivateDirectory(
        controlSocketDirectory(endpoint.path),
        custody,
      );
    } catch (error) {
      return error instanceof FsTrustError && error.kind === 'absent'
        ? 'stale'
        : 'untrusted';
    }
    try {
      const stat = await fs.lstat(endpoint.path);
      if (
        !stat.isSocket() ||
        stat.isSymbolicLink() ||
        (uid !== undefined && stat.uid !== uid) ||
        (stat.mode & 0o077) !== 0
      ) {
        return 'untrusted';
      }
      return 'vetted';
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'stale' : 'untrusted';
    }
  }

  function interpret(
    record: InstanceRecordV1,
    installation: VerifiedInstallation,
    response: ControlResponse,
    endpoint: VettedEndpoint | undefined,
  ): Probe | 'disagree' {
    if (!response.ok) {
      switch (response.code) {
        case 'forbidden':
          return UNTRUSTED;
        case 'internal':
          return failureOf('unknown');
        case 'unsupported_version':
        case 'unsupported_op':
        case 'bad_request':
        case 'too_large':
          return failureOf('unsupported_contract');
        default:
          return UNTRUSTED;
      }
    }
    const answer: InstanceStateResponse = response;
    if (
      answer.instanceNonce !== record.instanceNonce ||
      answer.productId !== record.productId ||
      answer.productId !== installation.bundle.productId
    ) {
      return 'disagree';
    }
    switch (answer.state) {
      case 'ready':
        return record.state === 'ready' && record.origin === answer.origin
          ? {
              kind: 'ready',
              origin: answer.origin,
              instanceNonce: answer.instanceNonce,
              productId: answer.productId,
              endpoint,
            }
          : 'disagree';
      case 'starting':
        return { kind: 'starting', instanceNonce: answer.instanceNonce };
      default:
        return failureOf(answer.code);
    }
  }

  /**
   * One look at the instance. With `waitMs` the question is `ensure-ready`
   * (the server answers when settled or when `waitMs` elapses), otherwise
   * `status`.
   */
  async function probe(
    installation: VerifiedInstallation,
    signal: AbortSignal | undefined,
    waitMs?: number,
  ): Promise<Probe> {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      const read = await readRecord(installation);
      if ('probe' in read) return read.probe;
      const { record } = read;

      const vetted = await vetEndpoint(record.control);
      if (vetted === 'stale') return ABSENT;
      if (vetted === 'untrusted') return UNTRUSTED;
      // Minted only here, after the checks, for exactly this record's endpoint.
      const endpoint =
        vetted === 'vetted' ? issueVettedEndpoint(record.control) : undefined;

      let response: ControlResponse;
      try {
        response =
          waitMs === undefined
            ? await sendControlRequest(
                record.control,
                { v: 1, op: 'status' },
                { timeoutMs: statusTimeoutMs, connectTimeoutMs, signal },
              )
            : await sendControlRequest(
                record.control,
                { v: 1, op: 'ensure-ready', timeoutMs: waitMs },
                {
                  timeoutMs: waitMs + statusTimeoutMs,
                  connectTimeoutMs,
                  signal,
                },
              );
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof DesktopContractError) {
          // Only a refused or missing endpoint proves nobody listens.
          if (error.code === 'control_unreachable') return ABSENT;
          if (error.code === 'control_timeout') {
            // A long poll that outlived its budget is still starting. A
            // status that is not answered in time came from something that
            // holds the endpoint: not proof that nobody serves.
            return waitMs === undefined
              ? UNRESPONSIVE
              : { kind: 'starting', instanceNonce: record.instanceNonce };
          }
          // Connected, then reset, closed or ended with no answer (for
          // example a server dropping connections past its limit): the
          // instance may be alive and busy, so never treat it as stale.
          if (error.code === 'control_indeterminate') return UNRESPONSIVE;
          if (error.code === 'unsupported_contract') {
            return failureOf('unsupported_contract');
          }
        }
        return UNTRUSTED;
      }

      const interpreted = interpret(record, installation, response, endpoint);
      if (interpreted !== 'disagree') return interpreted;
      // The shell may have restarted between the read and the connect.
      if (attempt >= 1) return failureOf('instance_mismatch');
      await clock.sleep(REREAD_DELAY_MS, signal);
    }
  }

  function toResult(result: Probe): RendezvousResult {
    switch (result.kind) {
      case 'ready':
        return frozen({
          state: 'ready',
          origin: result.origin,
          instanceNonce: result.instanceNonce,
          productId: result.productId,
          ...(result.endpoint === undefined
            ? {}
            : { endpoint: result.endpoint }),
        });
      case 'starting':
        return frozen({
          state: 'starting',
          instanceNonce: result.instanceNonce,
        });
      case 'failed':
        return frozen({ state: 'failed', code: result.code });
      case 'untrusted':
        return frozen({ state: 'untrusted_state' });
      case 'unresponsive':
        return frozen({ state: 'unresponsive' });
      default:
        return frozen({ state: 'not_running' });
    }
  }

  async function locate(): Promise<VerifiedInstallation | RendezvousResult> {
    try {
      return await options.locate();
    } catch (error) {
      return frozen(fromLocateError(error));
    }
  }

  function isResult(
    value: VerifiedInstallation | RendezvousResult,
  ): value is RendezvousResult {
    return 'state' in value && !('bundle' in value);
  }

  return {
    async status(statusOptions = {}) {
      throwIfAborted(statusOptions.signal);
      const located = await locate();
      if (isResult(located)) return located;
      return toResult(await probe(located, statusOptions.signal));
    },

    async ensureReady(ensureOptions = {}) {
      const timeoutMs =
        ensureOptions.timeoutMs ?? DEFAULT_ENSURE_READY_TIMEOUT_MS;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > MAX_ENSURE_READY_TIMEOUT_MS
      ) {
        throw new DesktopContractError('invalid_field', {
          field: 'timeoutMs',
        });
      }
      const start = ensureOptions.start ?? true;
      const { signal } = ensureOptions;
      throwIfAborted(signal);
      const deadline = clock.now() + timeoutMs;

      const located = await locate();
      if (isResult(located)) return located as EnsureReadyResult;
      const installation = located;

      let started = false;
      let waiting = false;
      // Set once a nonce-verified `starting` has been seen in this call. From
      // then on a dropped long poll is not evidence that nobody serves.
      let sawLive = false;
      // The last look found a holder that gave no usable answer: running out
      // of budget then reports that, not a plain timeout.
      let lastUnresponsive = false;
      let delay = pollIntervalMs;
      for (;;) {
        throwIfAborted(signal);
        const remaining = deadline - clock.now();
        if (remaining <= 0) {
          return frozen({
            state: lastUnresponsive ? 'unresponsive' : 'timeout',
          });
        }

        const asked = clock.now();
        const seen = await probe(
          installation,
          signal,
          waiting ? remaining : undefined,
        );
        lastUnresponsive = seen.kind === 'unresponsive';
        switch (seen.kind) {
          case 'ready':
          case 'failed':
          case 'untrusted':
            return toResult(seen) as EnsureReadyResult;
          case 'unresponsive': {
            // Never launch on top of something that holds the endpoint: ask
            // again with `status` (a held long-poll slot is not retried as
            // one) and give it the budget to answer.
            waiting = false;
            await clock.sleep(
              Math.min(delay, Math.max(0, deadline - clock.now())),
              signal,
            );
            delay = Math.min(Math.ceil(delay * 1.5), maxPollIntervalMs);
            break;
          }
          case 'starting': {
            waiting = true;
            sawLive = true;
            // A server that answers `starting` at once must not be spun on.
            const elapsed = clock.now() - asked;
            if (elapsed < pollIntervalMs) {
              await clock.sleep(
                Math.min(
                  pollIntervalMs - elapsed,
                  Math.max(0, deadline - clock.now()),
                ),
                signal,
              );
            }
            break;
          }
          default: {
            if (waiting && sawLive) {
              // The long poll was dropped or failed after a live instance was
              // verified: look again with `status` (bounded by the deadline
              // and the abort signal) before concluding anything. Only a
              // status that also finds no listener may lead to a launch,
              // never a second shell while the first may still be starting.
              waiting = false;
              await clock.sleep(
                Math.min(pollIntervalMs, Math.max(0, deadline - clock.now())),
                signal,
              );
              break;
            }
            waiting = false;
            if (!started) {
              if (!start) return frozen({ state: 'not_running' });
              started = true;
              if (!(await launch(installation))) {
                return frozen({ state: 'failed', code: 'launch_failed' });
              }
              delay = pollIntervalMs;
            }
            await clock.sleep(
              Math.min(delay, Math.max(0, deadline - clock.now())),
              signal,
            );
            delay = Math.min(Math.ceil(delay * 1.5), maxPollIntervalMs);
          }
        }
      }
    },
  };
}
