import {
  type ChildProcess,
  spawn as nodeSpawn,
  type SpawnOptions,
} from 'node:child_process';
import type { Duplex } from 'node:stream';
import { DesktopContractError } from '../errors.js';
import { isLoopbackOrigin } from '../internal/grammar.js';
import {
  type CredentialFailureCode,
  type CredentialLease,
  isCredentialFailureCode,
} from './control-handler.js';
import {
  containsSecret,
  encodeHandoffFrame,
  type HandoffFrame,
  HandoffFrameDecoder,
} from './handoff-frame.js';

type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** @experimental */
export type BridgeStdio = 'inherit' | 'pipe' | 'ignore';

/** @experimental */
export interface SpawnBridgeOptions {
  /** Absolute path of the bundled Node executable (or any bridge launcher). */
  readonly command: string;
  /** Arguments. They must not contain the bearer; `--credential-fd=3` is fine. */
  readonly args?: readonly string[];
  /**
   * The child's complete environment. It is NOT merged with `process.env`:
   * build it from scratch (for example `PATH`) and keep the bearer out of it.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** stdin, stdout, stderr of the child. Default `inherit`: the MCP channel. */
  readonly stdio?: readonly [BridgeStdio, BridgeStdio, BridgeStdio];
  /** The initial credential, sent as frame `seq` 0 before the child reads. */
  readonly lease: CredentialLease;
  /**
   * Answers a bridge `refresh` request with the latest lease (typically
   * `provider.acquire(...)` after `status`). Rejecting with a credential code
   * sends an `unavailable` frame with that code; any other failure sends
   * `credential_unavailable`. Without it every request is answered
   * `credential_unavailable`.
   */
  readonly refresh?: (signal: AbortSignal) => Promise<CredentialLease>;
  /** Test seam; defaults to `node:child_process`.`spawn`. */
  readonly spawn?: SpawnFunction;
}

/** @experimental */
export interface BridgeHandoff {
  readonly child: ChildProcess;
  /** Push a new credential (rotation or port change) over the pipe. */
  sendCredential(lease: CredentialLease): Promise<void>;
  /** Tell the bridge that no credential is available. */
  sendUnavailable(code: CredentialFailureCode): Promise<void>;
  /** Close the pipe. The child is not killed. */
  close(): void;
}

function failed(): DesktopContractError {
  return new DesktopContractError('handoff_failed');
}

/**
 * Spawn the bridge with an inherited anonymous pipe at descriptor 3 and send
 * it the initial credential frame.
 *
 * The bearer never appears in the child's argv or environment: both are
 * checked against it before spawning (`handoff_failed` if it is found), the
 * environment is exactly `env` (never inherited), `shell` is off, and the only
 * channel is the pipe. The pipe stays open for `refresh` requests and later
 * `sendCredential` calls, and is closed when the child exits.
 *
 * On POSIX the pipe is a socketpair, on Windows a named pipe (libuv extra
 * stdio), so both directions work on every platform.
 *
 * @experimental
 */
export function spawnBridgeWithCredential(
  options: SpawnBridgeOptions,
): BridgeHandoff {
  const { lease } = options;
  const args = options.args ?? [];
  if (
    !isLoopbackOrigin(lease?.origin) ||
    containsSecret(lease.token, [
      options.command,
      ...args,
      ...Object.entries(options.env).flat(),
      options.cwd ?? '',
    ])
  ) {
    throw failed();
  }

  const stdio = options.stdio ?? ['inherit', 'inherit', 'inherit'];
  let child: ChildProcess;
  try {
    child = (options.spawn ?? nodeSpawn)(options.command, args, {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: [...stdio, 'pipe'],
      shell: false,
      windowsHide: true,
    });
  } catch {
    throw failed();
  }
  const channel = child.stdio?.[3] as Duplex | null | undefined;
  if (!channel) {
    child.kill();
    throw failed();
  }

  const decoder = new HandoffFrameDecoder('to-launcher');
  const abort = new AbortController();
  let seq = 0;
  let closed = false;
  let refreshing = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    abort.abort();
    channel.destroy();
  };

  const write = (frame: HandoffFrame): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (closed || channel.destroyed || !channel.writable) {
        reject(failed());
        return;
      }
      let line: string;
      try {
        line = encodeHandoffFrame(frame, 'to-bridge');
      } catch (error) {
        reject(error instanceof DesktopContractError ? error : failed());
        return;
      }
      channel.write(line, (error) => (error ? reject(failed()) : resolve()));
    });

  const sendCredential = (next: CredentialLease): Promise<void> =>
    write({
      v: 1,
      type: 'credential',
      seq: seq++,
      origin: next.origin,
      token: next.token,
      expiresAt: next.expiresAt,
    });

  const sendUnavailable = (code: CredentialFailureCode): Promise<void> =>
    write({ v: 1, type: 'unavailable', seq: seq++, code });

  async function answerRefresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      let next: CredentialLease | undefined;
      let code: CredentialFailureCode = 'credential_unavailable';
      if (options.refresh) {
        try {
          next = await options.refresh(abort.signal);
        } catch (error) {
          const errorCode = (error as { code?: unknown } | null)?.code;
          if (isCredentialFailureCode(errorCode)) code = errorCode;
        }
      }
      if (closed) return;
      if (next) await sendCredential(next);
      else await sendUnavailable(code);
    } catch {
      // The pipe is gone or the lease was refused; the bridge will fail on its
      // own. Nothing may be logged: errors here sit next to a bearer.
    } finally {
      refreshing = false;
    }
  }

  channel.on('error', () => close());
  channel.on('close', () => {
    closed = true;
    abort.abort();
  });
  channel.on('data', (chunk: Uint8Array | string) => {
    try {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === 'refresh') void answerRefresh();
      }
    } catch {
      // A misbehaving peer: drop the channel.
      close();
    }
  });
  child.once('exit', close);
  child.once('error', close);

  // Queued in the kernel pipe before the child can read it.
  void sendCredential(lease).catch(() => close());

  return { child, sendCredential, sendUnavailable, close };
}
