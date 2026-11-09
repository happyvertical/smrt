import { randomBytes } from 'node:crypto';
import { DesktopContractError } from '../errors.js';
import { type DesktopFs, nodeFs } from '../internal/fs-seam.js';
import { isLoopbackOrigin } from '../internal/grammar.js';
import { writePrivateFileAtomic } from '../internal/private-file.js';
import type {
  ControlCodec,
  ControlRequest,
  ControlResponse,
  EnsureReadyRequest,
  InstanceStateResponse,
  StatusRequest,
} from './control-protocol.js';
import {
  type ControlHandler,
  type ControlHandlerRegistry,
  type ControlServer,
  createControlHandlerRegistry,
  serveControlChannelForTests,
} from './control-transport.js';
import { type ControlEndpoint, deriveControlEndpoint } from './endpoint.js';
import type { ShellFailureCode } from './failure-code.js';
import {
  INSTANCE_RECORD_FILENAME,
  type InstanceRecordV1,
  type InstanceState,
  serializeInstanceRecord,
} from './instance-record.js';

/**
 * Reference SERVER side of the rendezvous, exported as a test double (for
 * #4729 and any Node-based shell). The production server is the Rust shell;
 * this module has the same externally visible behavior:
 *
 * - a supervisor state machine (`starting` -> `ready` | `failed`, restart via
 *   `starting()`), pure and synchronous apart from `settle`;
 * - a control-channel handler for `status` and `ensure-ready` (registered in
 *   an extensible registry, so another contract adds its op);
 * - `startReferenceShell`, which binds a fresh unguessable endpoint and then
 *   publishes `instance.json` atomically on every phase change, and leaves
 *   the record in place on `close()` (the next client finds a stale endpoint).
 *
 * It enforces nothing the Rust shell does beyond Node's reach: there is no
 * peer-credential check, and no single-instance lock (tests model that with
 * their own fake). See `control-transport.ts`.
 *
 * @experimental
 */

export interface ReferenceSnapshot {
  readonly state: InstanceState;
  readonly origin?: string;
  readonly failure?: ShellFailureCode;
}

/** @experimental */
export interface ReferenceSupervisor {
  readonly productId: string;
  readonly instanceNonce: string;
  snapshot(): ReferenceSnapshot;
  /** Enter `starting` (also the tray Restart from `failed`). */
  starting(): void;
  /** Enter `ready` at `origin` (`http://127.0.0.1:<port>`). */
  ready(origin: string): void;
  /** Enter `failed` with a typed code. */
  fail(code: ShellFailureCode): void;
  /** Subscribe to every phase change. Returns an unsubscribe function. */
  onChange(listener: (snapshot: ReferenceSnapshot) => void): () => void;
  /**
   * Resolve with the first non-`starting` snapshot, or with the current
   * (`starting`) one after `timeoutMs` or when `signal` aborts.
   */
  settle(timeoutMs: number, signal?: AbortSignal): Promise<ReferenceSnapshot>;
  /** Answer one `status` or `ensure-ready` request. */
  respond(
    request: StatusRequest | EnsureReadyRequest,
    signal?: AbortSignal,
  ): Promise<InstanceStateResponse>;
}

/** @experimental */
export interface ReferenceSupervisorOptions {
  readonly productId: string;
  /** Defaults to 16 random bytes as 32 hex characters. */
  readonly instanceNonce?: string;
  /** Initial state. Defaults to `starting`. */
  readonly initial?: ReferenceSnapshot;
}

/** @experimental */
export function createReferenceSupervisor(
  options: ReferenceSupervisorOptions,
): ReferenceSupervisor {
  const instanceNonce =
    options.instanceNonce ?? randomBytes(16).toString('hex');
  let current: ReferenceSnapshot = options.initial ?? { state: 'starting' };
  const listeners = new Set<(snapshot: ReferenceSnapshot) => void>();

  const set = (next: ReferenceSnapshot) => {
    current = Object.freeze(next);
    for (const listener of [...listeners]) listener(current);
  };

  const supervisor: ReferenceSupervisor = {
    productId: options.productId,
    instanceNonce,
    snapshot: () => current,
    starting: () => set({ state: 'starting' }),
    ready(origin) {
      if (!isLoopbackOrigin(origin)) {
        throw new DesktopContractError('invalid_field', { field: 'origin' });
      }
      set({ state: 'ready', origin });
    },
    fail: (code) => set({ state: 'failed', failure: code }),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settle(timeoutMs, signal) {
      if (current.state !== 'starting' || signal?.aborted) {
        return Promise.resolve(current);
      }
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener('abort', done);
          resolve(current);
        };
        const timer = setTimeout(done, timeoutMs);
        const unsubscribe = supervisor.onChange(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    },
    async respond(request, signal) {
      const snapshot =
        request.op === 'ensure-ready'
          ? await supervisor.settle(request.timeoutMs, signal)
          : current;
      const base = {
        v: 1,
        ok: true,
        instanceNonce,
        productId: options.productId,
      } as const;
      switch (snapshot.state) {
        case 'ready':
          return { ...base, state: 'ready', origin: snapshot.origin as string };
        case 'failed':
          return {
            ...base,
            state: 'failed',
            code: snapshot.failure as ShellFailureCode,
          };
        default:
          return { ...base, state: 'starting' };
      }
    },
  };
  return supervisor;
}

/**
 * Build the handler registry a reference shell serves: `status` and
 * `ensure-ready` answered from `supervisor`. Callers may `register` more ops.
 *
 * @experimental
 */
export function createReferenceRegistry(
  supervisor: ReferenceSupervisor,
): ControlHandlerRegistry {
  const registry = createControlHandlerRegistry();
  registry.register('status', (request) => supervisor.respond(request));
  registry.register('ensure-ready', (request, context) =>
    // Ends early if the peer goes away; answers `starting` on the deadline.
    supervisor.respond(request, context.signal),
  );
  return registry;
}

/** @experimental */
export interface ReferenceShellOptions<
  Req extends { readonly op: string } = ControlRequest,
  Res extends { readonly ok: boolean } = ControlResponse,
> {
  /** The private state directory; `instance.json` is written here. */
  readonly shellDirectory: string;
  /**
   * Directory for the unix socket. Defaults to `shellDirectory`; pass a
   * shorter private directory when that path would exceed `sun_path`.
   */
  readonly socketDirectory?: string;
  readonly productId: string;
  readonly bundleId: string;
  /** Defaults to `1.0.0`. */
  readonly shellVersion?: string;
  /** Defaults to `process.pid`. */
  readonly pid?: number;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
  /** Use an existing supervisor (to drive transitions from the test). */
  readonly supervisor?: ReferenceSupervisor;
  /**
   * Handler registry. Defaults to `status` and `ensure-ready` only; an
   * extended registry needs the matching `codec`.
   */
  readonly registry?: ControlHandlerRegistry<Req, Res>;
  /** Wire codec. Defaults to `coreControlCodec`; pass an extended codec. */
  readonly codec?: ControlCodec<Req, Res>;
  readonly fs?: DesktopFs;
  readonly currentUid?: number;
  /** Passed to the control server (time a peer has to deliver its request). */
  readonly requestReadTimeoutMs?: number;
  /**
   * Required (as `true`) on Windows, where the test double's control server
   * has no ACL and no peer check. See `serveControlChannelForTests`.
   */
  readonly insecureForTests?: true;
  /** Passed to the control server (connections served at once). */
  readonly maxConnections?: number;
  /**
   * Called with every `instance.json` write that failed. The shell keeps
   * publishing later phases regardless; `flush()` and `close()` also rethrow
   * the first failure not yet reported.
   */
  readonly onWriteError?: (error: unknown) => void;
}

/** @experimental */
export interface ReferenceShell<
  Req extends { readonly op: string } = ControlRequest,
  Res extends { readonly ok: boolean } = ControlResponse,
> {
  readonly supervisor: ReferenceSupervisor;
  readonly endpoint: ControlEndpoint;
  readonly registry: ControlHandlerRegistry<Req, Res>;
  /** The record as currently published. */
  record(): InstanceRecordV1;
  /**
   * Resolves once every pending `instance.json` write has settled. Rejects
   * with the first write failure not yet reported (later writes still ran).
   */
  flush(): Promise<void>;
  /**
   * Stop serving and remove the socket. The record stays on disk. Rejects
   * with an unreported write failure, after the server has stopped.
   */
  close(): Promise<void>;
}

/** @experimental */
export async function startReferenceShell<
  Req extends { readonly op: string } = ControlRequest,
  Res extends { readonly ok: boolean } = ControlResponse,
>(options: ReferenceShellOptions<Req, Res>): Promise<ReferenceShell<Req, Res>> {
  const platform = options.platform ?? process.platform;
  const separator = platform === 'win32' ? '\\' : '/';
  const supervisor =
    options.supervisor ??
    createReferenceSupervisor({ productId: options.productId });
  // With no registry the codec is the core one, so Req/Res are the defaults.
  const registry =
    options.registry ??
    (createReferenceRegistry(supervisor) as unknown as ControlHandlerRegistry<
      Req,
      Res
    >);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const endpoint = deriveControlEndpoint({
    platform,
    bundleId: options.bundleId,
    directory: options.socketDirectory ?? options.shellDirectory,
  });
  const recordPath = `${options.shellDirectory}${separator}${INSTANCE_RECORD_FILENAME}`;
  const custody = {
    fs: options.fs ?? nodeFs,
    platform,
    ...('currentUid' in options ? { currentUid: options.currentUid } : {}),
  };

  const build = (): InstanceRecordV1 => {
    const snapshot = supervisor.snapshot();
    return {
      version: 1,
      productId: options.productId,
      bundleId: options.bundleId,
      instanceNonce: supervisor.instanceNonce,
      pid: options.pid ?? process.pid,
      shellVersion: options.shellVersion ?? '1.0.0',
      startedAt,
      updatedAt: now().toISOString(),
      control: endpoint,
      state: snapshot.state,
      ...(snapshot.origin === undefined ? {} : { origin: snapshot.origin }),
      ...(snapshot.failure === undefined ? {} : { failure: snapshot.failure }),
    };
  };

  // `writes` is the tail of the write chain and never rejects: a failed write
  // must not poison the ones after it (each one writes the state current when
  // it was queued, so a later write supersedes a lost one). Failures are kept
  // for the owner instead of being swallowed: `onWriteError`, then `flush()`
  // and `close()` rethrow the first one not yet reported.
  let writes: Promise<void> = Promise.resolve();
  const failures: unknown[] = [];
  const publish = (): Promise<void> => {
    const text = serializeInstanceRecord(build());
    const attempt = writes.then(() =>
      writePrivateFileAtomic(recordPath, text, custody),
    );
    writes = attempt.catch((error: unknown) => {
      failures.push(error);
      try {
        options.onWriteError?.(error);
      } catch {
        // A throwing observer must not break the chain either.
      }
    });
    return attempt;
  };
  const rethrowPending = (): void => {
    if (failures.length === 0) return;
    const [first] = failures.splice(0);
    throw first;
  };

  const server: ControlServer = await serveControlChannelForTests<Req, Res>(
    endpoint,
    registry.handler as ControlHandler<Req, Res>,
    {
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...('currentUid' in options ? { currentUid: options.currentUid } : {}),
      ...(options.requestReadTimeoutMs === undefined
        ? {}
        : { requestReadTimeoutMs: options.requestReadTimeoutMs }),
      platform,
      ...(options.insecureForTests === true ? { insecureForTests: true } : {}),
      ...(options.maxConnections === undefined
        ? {}
        : { maxConnections: options.maxConnections }),
    },
  );
  const unsubscribe = supervisor.onChange(() => {
    // Recorded in `failures`; the owner sees it through `flush()`/`close()`.
    void publish().catch(() => undefined);
  });
  try {
    await publish();
  } catch (error) {
    // Do not leave a listener behind a record that was never published.
    unsubscribe();
    await server.close();
    failures.length = 0;
    throw error;
  }

  return {
    supervisor,
    endpoint,
    registry,
    record: build,
    async flush() {
      await writes;
      rethrowPending();
    },
    async close() {
      unsubscribe();
      await server.close();
      await writes;
      rethrowPending();
    },
  };
}
