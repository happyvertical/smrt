import { promises as fsp } from 'node:fs';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { DesktopContractError } from '../errors.js';
import { assertPrivateDirectory } from '../internal/private-file.js';
import {
  type ControlCodec,
  type ControlErrorResponse,
  type ControlRequest,
  type ControlResponse,
  controlErrorCodeFor,
  coreControlCodec,
  MAX_CONTROL_MESSAGE_BYTES,
} from './control-protocol.js';
import { type ControlEndpoint, controlSocketDirectory } from './endpoint.js';

/**
 * Transport for the owner-only control channel, over `node:net`.
 *
 * Peer identity. The real check lives in the Rust shell: it reads the peer's
 * credentials (`SO_PEERCRED` on Linux, `getpeereid` on macOS,
 * `GetNamedPipeClientProcessId` plus the token user SID on Windows) before it
 * reads a byte, and a pipe DACL restricts Windows access to the current user.
 * Node exposes none of that: a `net.Socket` cannot report the peer uid or SID,
 * and a client cannot learn who owns the listening end. So this transport
 * performs no peer verification, and neither side may claim otherwise.
 *
 * For the TypeScript reference server the gate is the filesystem: the socket
 * lives in a private directory (owned by the user, mode 0700, checked before
 * listening) and the socket file itself is chmod 0600, so only the same OS
 * user can connect. The client's gate is the same directory check plus proof
 * of identity: the peer must answer with the `instanceNonce` published in
 * `instance.json`, which only the instance's owner could have written.
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 1000;
const DEFAULT_REQUEST_READ_TIMEOUT_MS = 2000;
const DEFAULT_MAX_CONNECTIONS = 16;

/**
 * `connect(2)` errors that prove nothing is listening at the address: the
 * name is gone or nobody holds it. Anything else, and every failure after a
 * successful connect, says something was there and the outcome is unknown.
 */
const NO_LISTENER_CODES = new Set(['ENOENT', 'ENOTDIR', 'ECONNREFUSED']);

function endpointAddress(endpoint: ControlEndpoint): string {
  return endpoint.kind === 'unix' ? endpoint.path : endpoint.name;
}

/** Exported for the platform check; a unix endpoint cannot exist on Windows. */
function assertEndpointPlatform(endpoint: ControlEndpoint): void {
  const windows = process.platform === 'win32';
  if ((endpoint.kind === 'pipe') !== windows) {
    throw new DesktopContractError('invalid_endpoint');
  }
}

export interface SendControlRequestOptions<
  Req extends { readonly op: string } = ControlRequest,
  Res extends { readonly ok: boolean } = ControlResponse,
> {
  /** Time allowed for the response once connected, in milliseconds. */
  readonly timeoutMs: number;
  /** Time allowed to connect. Defaults to 1000. */
  readonly connectTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Defaults to the core codec (`status`, `ensure-ready`). */
  readonly codec?: ControlCodec<Req, Res>;
}

/**
 * Send one request and read one response over the control channel.
 *
 * Resolves with the parsed response, which may be an `ok: false` answer (a
 * protocol-level refusal is data, not an exception). Rejects with a
 * `DesktopContractError`:
 *
 * - `control_unreachable`: proof that nothing listens (`ENOENT`, `ENOTDIR` or
 *   `ECONNREFUSED` while connecting). Only this means a stale endpoint.
 * - `control_indeterminate`: something accepted or may have accepted, and no
 *   usable answer came: a reset, close or end after connecting (a server that
 *   is saturated drops connections past its limit), or a connect error that is
 *   not a refusal. The instance may be alive; never read it as stale.
 * - `control_timeout`, `control_aborted`,
 * `invalid_endpoint`, or a codec code for an unparseable response
 * (`invalid_json`, `duplicate_keys`, `invalid_control_message`,
 * `control_message_too_large`, `unsupported_contract`). Nothing is written to
 * disk and no message echoes a path, pid or payload.
 */
export function sendControlRequest<
  Req extends { readonly op: string } = ControlRequest,
  Res extends { readonly ok: boolean } = ControlResponse,
>(
  endpoint: ControlEndpoint,
  request: Req,
  options: SendControlRequestOptions<Req, Res>,
): Promise<Res> {
  const codec = (options.codec ?? coreControlCodec) as unknown as ControlCodec<
    Req,
    Res
  >;
  const signal = options.signal;
  return new Promise<Res>((resolve, reject) => {
    let settled = false;
    let connected = false;
    let socket: Socket | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let responseTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      signal?.removeEventListener('abort', onAbort);
      socket?.destroy();
      action();
    };
    const fail = (
      code: ConstructorParameters<typeof DesktopContractError>[0],
    ) => finish(() => reject(new DesktopContractError(code)));
    const onAbort = () => fail('control_aborted');

    let line: string;
    try {
      assertEndpointPlatform(endpoint);
      line = codec.encodeRequest(request);
    } catch (error) {
      reject(error);
      return;
    }
    if (signal?.aborted) {
      reject(new DesktopContractError('control_aborted'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const chunks: Buffer[] = [];
    let received = 0;
    socket = createConnection({ path: endpointAddress(endpoint) });
    connectTimer = setTimeout(
      () => fail('control_timeout'),
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
    socket.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      responseTimer = setTimeout(
        () => fail('control_timeout'),
        options.timeoutMs,
      );
      socket?.write(line, 'utf8');
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      const joined = Buffer.concat(chunks);
      const newline = joined.indexOf(0x0a);
      if (newline === -1) {
        if (received > MAX_CONTROL_MESSAGE_BYTES + 1) {
          fail('control_message_too_large');
        }
        return;
      }
      finish(() => {
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(
            joined.subarray(0, newline + 1),
          );
          resolve(codec.parseResponse(request.op, text));
        } catch (error) {
          reject(
            error instanceof DesktopContractError
              ? error
              : new DesktopContractError('invalid_control_message'),
          );
        }
      });
    });
    // Only a refusal or a missing name before the connection is "nobody
    // there". A reset, close or end after it (or any other error) means a
    // server may be alive: report that as indeterminate so the caller does not
    // start a second instance on top of a busy one. The caller never retries
    // the write.
    socket.once('error', (error: NodeJS.ErrnoException) =>
      fail(
        !connected && NO_LISTENER_CODES.has(String(error?.code))
          ? 'control_unreachable'
          : 'control_indeterminate',
      ),
    );
    socket.once('close', () => fail('control_indeterminate'));
    socket.once('end', () => fail('control_indeterminate'));
  });
}

/** What a handler learns about the connection it serves. */
export interface ControlRequestContext {
  /** Aborted if the peer disconnects or the server closes before the answer. */
  readonly signal: AbortSignal;
}

/**
 * Answers one request. May return a protocol-level error response; a thrown
 * error is answered as `internal` without echoing its message.
 */
export type ControlHandler<
  Req extends { readonly op: string } = ControlRequest,
  Res extends { readonly ok: boolean } = ControlResponse,
> = (request: Req, context: ControlRequestContext) => Res | Promise<Res>;

/**
 * A registry maps each op to its handler; its `handler` plugs into
 * `serveControlChannel`. Ops are open: a contract adds its own `register`
 * call. An op without a handler is answered `unsupported_op`.
 */
export interface ControlHandlerRegistry<
  Req extends { readonly op: string } = ControlRequest,
  Res extends { readonly ok: boolean } = ControlResponse,
> {
  register<Op extends Req['op']>(
    op: Op,
    handler: ControlHandler<Extract<Req, { readonly op: Op }>, Res>,
  ): this;
  has(op: string): boolean;
  readonly handler: ControlHandler<Req, Res>;
}

export function createControlHandlerRegistry<
  Req extends { readonly op: string } = ControlRequest,
  Res extends { readonly ok: boolean } = ControlResponse,
>(): ControlHandlerRegistry<Req, Res> {
  const handlers = new Map<string, ControlHandler<never, Res>>();
  const registry: ControlHandlerRegistry<Req, Res> = {
    register(op, handler) {
      if (handlers.has(op)) throw new DesktopContractError('unsupported_op');
      handlers.set(op, handler as ControlHandler<never, Res>);
      return registry;
    },
    has: (op) => handlers.has(op),
    handler: (request, context) => {
      const handler = handlers.get(request.op) as
        | ControlHandler<Req, Res>
        | undefined;
      if (handler === undefined) {
        throw new DesktopContractError('unsupported_op');
      }
      return handler(request, context);
    },
  };
  return registry;
}

export interface ServeControlChannelOptions<
  Req extends { readonly op: string } = ControlRequest,
  Res extends { readonly ok: boolean } = ControlResponse,
> {
  readonly codec?: ControlCodec<Req, Res>;
  /** Time a peer has to deliver its request line. Defaults to 2000. */
  readonly requestReadTimeoutMs?: number;
  /** Connections served at once; extra connections are dropped. Default 16. */
  readonly maxConnections?: number;
  /** Test seam: the effective uid the private directory must belong to. */
  readonly currentUid?: number;
}

export interface ControlServer {
  readonly endpoint: ControlEndpoint;
  /** Stop listening, drop open connections and remove the socket file. */
  close(): Promise<void>;
}

function errorResponse(code: string): ControlErrorResponse {
  return { v: 1, ok: false, code };
}

/**
 * Reference control-channel server (the production server is Rust; this one
 * backs tests and any Node-based shell). It listens on `endpoint`, serves one
 * request per connection and closes.
 *
 * Unix: the socket's parent directory must already be a real directory owned
 * by the user with mode 0700 (`untrusted_endpoint` otherwise), the path must
 * not exist (never unlinked or replaced: the name is fresh per start), and the
 * socket is chmod 0600 after binding. See the module comment: Node cannot
 * verify the peer, the directory is the gate.
 *
 * Rejects with `invalid_endpoint`, `untrusted_endpoint` or
 * `control_server_failed`.
 */
export async function serveControlChannel<
  Req extends { readonly op: string } = ControlRequest,
  Res extends { readonly ok: boolean } = ControlResponse,
>(
  endpoint: ControlEndpoint,
  handler: ControlHandler<Req, Res>,
  options: ServeControlChannelOptions<Req, Res> = {},
): Promise<ControlServer> {
  const codec = (options.codec ?? coreControlCodec) as unknown as ControlCodec<
    Req,
    Res
  >;
  assertEndpointPlatform(endpoint);
  if (endpoint.kind === 'unix') {
    try {
      await assertPrivateDirectory(controlSocketDirectory(endpoint.path), {
        ...('currentUid' in options ? { currentUid: options.currentUid } : {}),
      });
    } catch {
      throw new DesktopContractError('untrusted_endpoint');
    }
  }

  const readTimeoutMs =
    options.requestReadTimeoutMs ?? DEFAULT_REQUEST_READ_TIMEOUT_MS;
  const sockets = new Set<Socket>();
  const server: Server = createServer();
  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

  server.on('connection', (socket) => {
    sockets.add(socket);
    const peerGone = new AbortController();
    let answered = false;
    let buffered = Buffer.alloc(0);
    const readTimer = setTimeout(() => socket.destroy(), readTimeoutMs);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      clearTimeout(readTimer);
      sockets.delete(socket);
      peerGone.abort();
    });

    const respond = (response: Res | ControlErrorResponse) => {
      if (answered) return;
      answered = true;
      clearTimeout(readTimer);
      let text: string;
      try {
        text = codec.encodeResponse(response as Res);
      } catch {
        text = codec.encodeResponse(
          errorResponse('internal') as unknown as Res,
        );
      }
      socket.end(text, 'utf8');
    };

    const serve = async (line: string) => {
      let request: Req;
      try {
        request = codec.parseRequest(line);
      } catch (error) {
        respond(errorResponse(controlErrorCodeFor(error)));
        return;
      }
      try {
        respond(await handler(request, { signal: peerGone.signal }));
      } catch (error) {
        const code = controlErrorCodeFor(error);
        respond(errorResponse(code === 'unsupported_op' ? code : 'internal'));
      }
    };

    const onData = (chunk: Buffer) => {
      if (answered || buffered.length > MAX_CONTROL_MESSAGE_BYTES + 1) return;
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length > MAX_CONTROL_MESSAGE_BYTES) {
          respond(errorResponse('too_large'));
        }
        return;
      }
      // A complete request line has arrived: the read window is over. The
      // timer only guards the delivery of the line, never the handler, which
      // may legitimately run a long poll (`ensure-ready`). Dispatch happens
      // exactly once; later bytes are not buffered or re-parsed.
      clearTimeout(readTimer);
      socket.off('data', onData);
      let line: string;
      try {
        line = new TextDecoder('utf-8', { fatal: true }).decode(
          buffered.subarray(0, newline + 1),
        );
      } catch {
        respond(errorResponse('bad_request'));
        return;
      }
      buffered = Buffer.alloc(0);
      void serve(line);
    };
    socket.on('data', onData);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', () =>
      reject(new DesktopContractError('control_server_failed')),
    );
    server.listen({ path: endpointAddress(endpoint) }, resolve);
  });
  if (endpoint.kind === 'unix') {
    try {
      await fsp.chmod(endpoint.path, 0o600);
    } catch {
      server.close();
      throw new DesktopContractError('control_server_failed');
    }
  }

  let closing: Promise<void> | undefined;
  return {
    endpoint,
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}
