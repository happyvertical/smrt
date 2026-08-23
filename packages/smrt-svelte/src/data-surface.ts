/**
 * Authenticated browser bridge for mounted data surfaces.
 *
 * `smrt-ui` owns the local registry and deliberately knows nothing about
 * transports or authentication. This adapter is the browser-side trust
 * boundary: only a request carrying the configured session and peer source is
 * delivered to the registry. A command is successful only after its ack has
 * travelled back through the transport.
 */

import {
  type DataSurfaceCommandResult,
  type DataSurfaceIdentity,
  type DataSurfaceRegistry,
  type DataSurfaceRegistryEvent,
  type DataSurfaceSnapshot,
  type DataSurfaceVisibleCommand,
  normalizeDataSurfaceVisibleCommand,
} from '@happyvertical/smrt-ui/data';
import { DATA_SURFACE_IDENTIFIER_MAX_LENGTH } from '@happyvertical/smrt-ui/data-surface';

export const DATA_SURFACE_BRIDGE_VERSION = 1 as const;
export const DEFAULT_DATA_SURFACE_BRIDGE_TTL_MS = 30_000;
export const DEFAULT_DATA_SURFACE_BRIDGE_REPLAY_ENTRIES = 100;
export { DATA_SURFACE_IDENTIFIER_MAX_LENGTH } from '@happyvertical/smrt-ui/data-surface';

export type DataSurfaceBridgeFailureReason =
  | 'not_found'
  | 'unsupported'
  | 'stale_revision'
  | 'idempotency_conflict'
  | 'denied'
  | 'execution_failed'
  | 'non_monotonic_revision'
  | 'expired'
  | 'timeout'
  | 'disconnected'
  | 'invalid_request'
  | 'source_mismatch'
  | 'session_mismatch'
  | 'replay_capacity_exceeded';

export interface DataSurfaceCommandRequest {
  type: 'data-surface.command';
  version: typeof DATA_SURFACE_BRIDGE_VERSION;
  commandId: string;
  sessionId: string;
  /** Authenticated peer/source id, never a profile or tenant authority. */
  source: string;
  expiresAt: number;
  identity: DataSurfaceIdentity;
  expectedRevision: number;
  controlId: string;
  payload?: DataSurfaceVisibleCommand['payload'];
}

export interface DataSurfaceCommandAck {
  type: 'data-surface.ack';
  version: typeof DATA_SURFACE_BRIDGE_VERSION;
  commandId: string;
  sessionId: string;
  source: string;
  expiresAt: number;
  identity: DataSurfaceIdentity;
  expectedRevision: number;
  ok: boolean;
  revision?: number;
  snapshot?: DataSurfaceSnapshot;
  reason?: DataSurfaceBridgeFailureReason;
}

export interface DataSurfaceBridgeEvent {
  type: 'data-surface.event';
  version: typeof DATA_SURFACE_BRIDGE_VERSION;
  sessionId: string;
  source: string;
  sequence: number;
  identity: DataSurfaceIdentity;
  revision: number;
  event: DataSurfaceRegistryEvent['type'];
  command?: DataSurfaceVisibleCommand;
  result?: DataSurfaceCommandResult;
}

export type DataSurfaceBridgeMessage =
  | DataSurfaceCommandRequest
  | DataSurfaceCommandAck
  | DataSurfaceBridgeEvent;

/**
 * Identity verified by the transport adapter, outside the wire message.
 * Adapters must derive this from authenticated connection state (for example,
 * a bound WebSocket session or an origin-checked postMessage peer), never
 * from fields in `message`. `send` must route only to that bound peer.
 */
export interface DataSurfaceBridgePeer {
  sessionId: string;
  source: string;
}

export type DataSurfaceBridgeConnectionState =
  | 'connected'
  | 'disconnected'
  | 'reconnecting';

/** A deliberately tiny adapter for WebSocket, SSE, postMessage, or a test. */
export interface DataSurfaceBridgeTransport {
  send(message: DataSurfaceBridgeMessage): void | Promise<void>;
  subscribe(
    listener: (message: unknown, peer: DataSurfaceBridgePeer) => void,
  ): () => void;
  subscribeStatus?: (
    listener: (state: DataSurfaceBridgeConnectionState) => void,
  ) => () => void;
}

export interface DataSurfaceBrowserBridgeOptions {
  registry: DataSurfaceRegistry;
  transport: DataSurfaceBridgeTransport;
  sessionId: string;
  /** This browser's source id, placed on acknowledgements/events. */
  source: string;
  /** The only server source accepted for commands. */
  peerSource: string;
  now?: () => number;
  maxTtlMs?: number;
  maxReplayEntries?: number;
}

export interface DataSurfaceBrowserBridge {
  readonly sessionId: string;
  readonly source: string;
  /** Stop receiving transport messages and registry events. */
  dispose(): void;
  /** Handle a message directly; useful for transports that batch delivery. */
  receive(message: unknown, peer: DataSurfaceBridgePeer): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DATA_SURFACE_IDENTIFIER_MAX_LENGTH
  );
}

function isDisplayString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPeer(value: unknown): value is DataSurfaceBridgePeer {
  return isRecord(value) && isString(value.sessionId) && isString(value.source);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function identityOf(value: unknown): DataSurfaceIdentity | undefined {
  if (!isRecord(value) || !isString(value.surfaceId) || !isString(value.kind)) {
    return undefined;
  }
  if (
    value.kind !== 'table' &&
    value.kind !== 'list' &&
    value.kind !== 'report' &&
    value.kind !== 'custom'
  ) {
    return undefined;
  }
  if (value.subject !== undefined) {
    if (
      !isRecord(value.subject) ||
      !isString(value.subject.type) ||
      !isString(value.subject.id) ||
      (value.subject.label !== undefined &&
        !isDisplayString(value.subject.label))
    ) {
      return undefined;
    }
  }
  return value as unknown as DataSurfaceIdentity;
}

function isRequest(value: unknown): value is DataSurfaceCommandRequest {
  if (
    !isRecord(value) ||
    value.type !== 'data-surface.command' ||
    value.version !== 1
  ) {
    return false;
  }
  return (
    isString(value.commandId) &&
    isString(value.sessionId) &&
    isString(value.source) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    identityOf(value.identity) !== undefined &&
    isFiniteInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    isString(value.controlId)
  );
}

function commandSignature(request: DataSurfaceCommandRequest): string {
  return JSON.stringify({
    sessionId: request.sessionId,
    source: request.source,
    identity: request.identity,
    expectedRevision: request.expectedRevision,
    controlId: request.controlId,
    payload: request.payload,
  });
}

function cloneMessage<T>(message: T): T {
  return JSON.parse(JSON.stringify(message)) as T;
}

/**
 * Attach a mounted registry to an authenticated browser transport.
 * Malformed requests and messages from unauthenticated peers are ignored before
 * acknowledgement. Valid requests from the bound peer that are expired,
 * cross-session, or cross-source are acknowledged without exposing a registry
 * snapshot. Replays return the original ack and do not invoke the mounted
 * surface a second time.
 */
export function createDataSurfaceBrowserBridge(
  options: DataSurfaceBrowserBridgeOptions,
): DataSurfaceBrowserBridge {
  if (
    !isString(options.sessionId) ||
    !isString(options.source) ||
    !isString(options.peerSource)
  ) {
    throw new TypeError('DataSurface bridge session/source ids are required');
  }
  const now = options.now ?? (() => Date.now());
  const maxTtlMs = options.maxTtlMs ?? DEFAULT_DATA_SURFACE_BRIDGE_TTL_MS;
  const maxReplayEntries =
    options.maxReplayEntries ?? DEFAULT_DATA_SURFACE_BRIDGE_REPLAY_ENTRIES;
  if (
    !Number.isFinite(maxTtlMs) ||
    maxTtlMs <= 0 ||
    !Number.isSafeInteger(maxReplayEntries) ||
    maxReplayEntries <= 0
  ) {
    throw new RangeError('Invalid DataSurface bridge bounds');
  }

  const replay = new Map<
    string,
    { signature: string; ack: DataSurfaceCommandAck; expiresAt: number }
  >();
  const reservations = new Set<string>();
  const inflight = new Map<
    string,
    {
      signature: string;
      promise: Promise<void>;
      expiry: Promise<void>;
      expired: boolean;
      expiryTimer: ReturnType<typeof setTimeout>;
    }
  >();
  let disposed = false;
  let lastSequence = 0;

  const pruneReplay = () => {
    const current = now();
    for (const [commandId, entry] of replay) {
      if (entry.expiresAt <= current) replay.delete(commandId);
    }
  };

  const remember = (
    request: DataSurfaceCommandRequest,
    ack: DataSurfaceCommandAck,
  ) => {
    replay.set(request.commandId, {
      signature: commandSignature(request),
      ack: cloneMessage(ack),
      expiresAt: request.expiresAt,
    });
  };

  const replayAck = (
    request: DataSurfaceCommandRequest,
    ack: DataSurfaceCommandAck,
  ): DataSurfaceCommandAck => ({
    ...cloneMessage(ack),
    expiresAt: request.expiresAt,
  });

  const sendAck = async (ack: DataSurfaceCommandAck) => {
    if (disposed) return;
    try {
      await options.transport.send(cloneMessage(ack));
    } catch {
      // A disconnected browser cannot repair delivery. The server-side
      // bridge reports the bounded disconnect/timeout outcome to its caller.
    }
  };

  const rejected = (
    request: Partial<DataSurfaceCommandRequest>,
    reason: DataSurfaceBridgeFailureReason,
  ): DataSurfaceCommandAck => ({
    type: 'data-surface.ack',
    version: 1,
    commandId:
      typeof request.commandId === 'string' ? request.commandId : 'invalid',
    sessionId: options.sessionId,
    source: options.source,
    expiresAt:
      typeof request.expiresAt === 'number' ? request.expiresAt : now(),
    identity: identityOf(request.identity) ?? {
      surfaceId: 'unknown',
      kind: 'custom',
    },
    expectedRevision:
      isFiniteInteger(request.expectedRevision) && request.expectedRevision >= 0
        ? request.expectedRevision
        : 0,
    ok: false,
    reason,
  });

  const receive = async (
    value: unknown,
    peer: DataSurfaceBridgePeer,
  ): Promise<void> => {
    if (
      disposed ||
      !isRequest(value) ||
      !isPeer(peer) ||
      peer.sessionId !== options.sessionId ||
      peer.source !== options.peerSource
    )
      return;
    const request = value;
    pruneReplay();
    const current = now();
    if (
      request.expiresAt <= current ||
      request.expiresAt - current > maxTtlMs
    ) {
      await sendAck(rejected(request, 'expired'));
      return;
    }
    const existing = replay.get(request.commandId);
    const signature = commandSignature(request);
    if (existing) {
      await sendAck(
        existing.signature === signature
          ? replayAck(request, existing.ack)
          : rejected(request, 'idempotency_conflict'),
      );
      return;
    }
    const active = inflight.get(request.commandId);
    if (active) {
      if (active.signature !== signature) {
        await sendAck(rejected(request, 'idempotency_conflict'));
        return;
      }
      await Promise.race([active.promise, active.expiry]);
      const completed = replay.get(request.commandId);
      if (completed?.signature === signature) {
        await sendAck(replayAck(request, completed.ack));
      } else if (active.expired || request.expiresAt <= now()) {
        await sendAck(rejected(request, 'expired'));
      }
      return;
    }

    let ack: DataSurfaceCommandAck | undefined;
    if (request.sessionId !== options.sessionId) {
      ack = rejected(request, 'session_mismatch');
    } else if (request.source !== options.peerSource) {
      ack = rejected(request, 'source_mismatch');
    } else if (replay.size + reservations.size >= maxReplayEntries) {
      ack = rejected(request, 'replay_capacity_exceeded');
    } else {
      reservations.add(request.commandId);
      let resolveExpiry!: () => void;
      const expiry = new Promise<void>((resolve) => {
        resolveExpiry = resolve;
      });
      const active = {
        signature,
        promise: Promise.resolve(),
        expiry,
        expired: false,
        expiryAckSent: false,
        expiryTimer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      let promise!: Promise<void>;
      promise = (async () => {
        try {
          let resultAck: DataSurfaceCommandAck;
          try {
            const command = normalizeDataSurfaceVisibleCommand({
              version: 1,
              commandId: request.commandId,
              identity: request.identity,
              expectedRevision: request.expectedRevision,
              controlId: request.controlId,
              ...(request.payload === undefined
                ? {}
                : { payload: request.payload }),
            });
            const result = await options.registry.execute(command);
            resultAck = {
              type: 'data-surface.ack',
              version: 1,
              commandId: request.commandId,
              sessionId: options.sessionId,
              source: options.source,
              expiresAt: request.expiresAt,
              identity: result.identity,
              expectedRevision: request.expectedRevision,
              ok: result.ok,
              revision: result.revision,
              snapshot: result.snapshot,
              reason: result.reason,
            };
          } catch {
            resultAck = rejected(request, 'invalid_request');
          }
          if (active.expired || request.expiresAt <= now()) {
            active.expired = true;
            reservations.delete(request.commandId);
            if (inflight.get(request.commandId)?.promise === promise) {
              inflight.delete(request.commandId);
            }
            clearTimeout(active.expiryTimer);
            resolveExpiry();
            if (!active.expiryAckSent) {
              active.expiryAckSent = true;
              await sendAck(rejected(request, 'expired'));
            }
            return;
          }
          remember(request, resultAck);
          reservations.delete(request.commandId);
          if (inflight.get(request.commandId)?.promise === promise) {
            inflight.delete(request.commandId);
          }
          clearTimeout(active.expiryTimer);
          resolveExpiry();
          await sendAck(resultAck);
        } finally {
          reservations.delete(request.commandId);
          if (inflight.get(request.commandId)?.promise === promise) {
            inflight.delete(request.commandId);
          }
          clearTimeout(active.expiryTimer);
          resolveExpiry();
        }
      })();
      active.promise = promise;
      active.expiryTimer = setTimeout(
        () => {
          if (inflight.get(request.commandId)?.promise !== promise) return;
          active.expired = true;
          reservations.delete(request.commandId);
          inflight.delete(request.commandId);
          resolveExpiry();
          active.expiryAckSent = true;
          void sendAck(rejected(request, 'expired'));
        },
        Math.max(0, request.expiresAt - current),
      );
      inflight.set(request.commandId, active);
      try {
        await Promise.race([promise, expiry]);
      } finally {
        if (inflight.get(request.commandId)?.promise === promise) {
          inflight.delete(request.commandId);
        }
      }
      return;
    }
    if (ack !== undefined) await sendAck(ack);
  };

  const emit = (event: DataSurfaceRegistryEvent) => {
    if (disposed || event.sequence <= lastSequence) return;
    lastSequence = event.sequence;
    const message: DataSurfaceBridgeEvent = {
      type: 'data-surface.event',
      version: 1,
      sessionId: options.sessionId,
      source: options.source,
      sequence: event.sequence,
      identity: event.identity,
      revision: event.revision,
      event: event.type,
      ...(event.command ? { command: event.command } : {}),
      ...(event.result ? { result: event.result } : {}),
    };
    void Promise.resolve(options.transport.send(cloneMessage(message))).catch(
      () => undefined,
    );
  };

  const unsubscribeTransport = options.transport.subscribe((message, peer) => {
    void receive(message, peer);
  });
  const unsubscribeRegistry = options.registry.subscribe(emit);

  return {
    sessionId: options.sessionId,
    source: options.source,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeTransport();
      unsubscribeRegistry();
      replay.clear();
    },
    receive,
  };
}

/** Compatibility alias that makes the browser role explicit at call sites. */
export const createDataSurfaceBridge = createDataSurfaceBrowserBridge;
