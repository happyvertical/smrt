/**
 * Server-side half of the authenticated data-surface bridge.
 *
 * This module is transport-neutral on purpose. An application supplies its
 * authenticated WebSocket/postMessage adapter and an authorization callback;
 * the chat package never treats browser acknowledgement as persistence or
 * server authorization. The callback is required and receives only the
 * server-bound session context, never authority supplied by the command.
 */

import { DATA_SURFACE_IDENTIFIER_MAX_LENGTH } from '@happyvertical/smrt-ui/data-surface';
import {
  assertDataSurfaceEnvelope,
  normalizeDataSurfaceSnapshot,
  normalizeDataSurfaceVisibleCommand,
} from './data-surface-normalizer.js';

// Keep the wire contract self-contained in this package's declarations. These
// serializable shapes intentionally mirror #2442. Runtime validation is
// kept in this package's Node-safe local normalizer so this server entry has no
// Svelte-bearing dependency.
export type DataSurfaceJsonPrimitive = string | number | boolean | null;
export type DataSurfaceJsonValue =
  | DataSurfaceJsonPrimitive
  | DataSurfaceJsonValue[]
  | { [key: string]: DataSurfaceJsonValue };
export type DataSurfaceKind = 'table' | 'list' | 'report' | 'custom';
export interface DataSurfaceSubject {
  type: string;
  id: string;
  label?: string;
}
export interface DataSurfaceIdentity {
  surfaceId: string;
  kind: DataSurfaceKind;
  subject?: DataSurfaceSubject;
}

export type DataSurfaceCommandResultReason =
  | 'not_found'
  | 'unsupported'
  | 'stale_revision'
  | 'idempotency_conflict'
  | 'denied'
  | 'execution_failed'
  | 'non_monotonic_revision';
export interface DataSurfaceDescriptor {
  version: 1;
  identity: DataSurfaceIdentity;
  schemaVersion: number;
  label: string;
  description?: string;
  rowKey: string;
  columns: Array<{
    id: string;
    label: string;
    description?: string;
    sensitivity?: 'public' | 'personal' | 'sensitive' | 'secret';
    capabilities: Array<'read' | 'search' | 'filter' | 'sort' | 'project'>;
  }>;
  query: {
    modes: Array<'rows' | 'count' | 'facets'>;
    projectableColumnIds: string[];
  };
  controls: Array<{ id: string; label: string; description?: string }>;
  actions: Array<{
    id: string;
    label: string;
    description?: string;
    sensitivity?: 'public' | 'personal' | 'sensitive' | 'secret';
    selectionScopes: Array<'current-page' | 'explicit-ids' | 'all-matching'>;
    requiresConfirmation?: boolean;
  }>;
  limits: {
    maxQueryRows: number;
    maxQueryBytes: number;
    maxSelectionSize: number;
  };
}
export type DataSurfaceSelectionReference =
  | { scope: 'current-page' }
  | { scope: 'explicit-ids'; rowIds: Array<string | number> }
  | { scope: 'all-matching'; queryFingerprint: string };
export interface DataSurfaceSnapshot {
  version: 1;
  descriptor: DataSurfaceDescriptor;
  revision: number;
  state: { [key: string]: DataSurfaceJsonValue };
  selection: DataSurfaceSelectionReference | null;
}
export interface DataSurfaceVisibleCommand {
  version: 1;
  commandId: string;
  identity: DataSurfaceIdentity;
  expectedRevision: number;
  controlId: string;
  payload?: DataSurfaceJsonValue;
}
export interface DataSurfaceCommandResult {
  ok: boolean;
  commandId: string;
  identity: DataSurfaceIdentity;
  revision?: number;
  snapshot?: DataSurfaceSnapshot;
  reason?: DataSurfaceCommandResultReason;
}

export const DATA_SURFACE_BRIDGE_VERSION = 1 as const;
export const DEFAULT_DATA_SURFACE_BRIDGE_TTL_MS = 30_000;

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
  event: 'registered' | 'unregistered' | 'command';
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

export interface DataSurfaceBridgeTransport {
  send(message: DataSurfaceBridgeMessage): void | Promise<void>;
  subscribe(
    listener: (message: unknown, peer: DataSurfaceBridgePeer) => void,
  ): () => void;
  subscribeStatus?: (
    listener: (state: DataSurfaceBridgeConnectionState) => void,
  ) => () => void;
}

export interface DataSurfaceCommandBridgeOptions {
  transport: DataSurfaceBridgeTransport;
  /** Server-authenticated browser session binding. */
  sessionId: string;
  /** Server source id placed on requests. */
  source: string;
  /** Browser source id accepted for acknowledgements/events. */
  peerSource: string;
  /** Must enforce application authorization; no default permit path exists. */
  authorize: (command: DataSurfaceVisibleCommand) => boolean | Promise<boolean>;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

export interface DataSurfaceCommandBridge {
  readonly sessionId: string;
  readonly source: string;
  readonly state: DataSurfaceBridgeConnectionState;
  send(command: DataSurfaceVisibleCommand): Promise<DataSurfaceCommandAck>;
  subscribe(listener: (event: DataSurfaceBridgeEvent) => void): () => void;
  dispose(): void;
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

function isFailureReason(
  value: unknown,
): value is DataSurfaceBridgeFailureReason {
  return (
    value === 'not_found' ||
    value === 'unsupported' ||
    value === 'stale_revision' ||
    value === 'idempotency_conflict' ||
    value === 'denied' ||
    value === 'execution_failed' ||
    value === 'non_monotonic_revision' ||
    value === 'expired' ||
    value === 'timeout' ||
    value === 'disconnected' ||
    value === 'invalid_request' ||
    value === 'source_mismatch' ||
    value === 'session_mismatch' ||
    value === 'replay_capacity_exceeded'
  );
}

function isCommandResultReason(
  value: unknown,
): value is DataSurfaceCommandResultReason {
  return (
    value === 'not_found' ||
    value === 'unsupported' ||
    value === 'stale_revision' ||
    value === 'idempotency_conflict' ||
    value === 'denied' ||
    value === 'execution_failed' ||
    value === 'non_monotonic_revision'
  );
}

function identityOf(value: unknown): DataSurfaceIdentity | undefined {
  if (!isRecord(value) || !isString(value.surfaceId) || !isString(value.kind))
    return undefined;
  if (
    value.kind !== 'table' &&
    value.kind !== 'list' &&
    value.kind !== 'report' &&
    value.kind !== 'custom'
  )
    return undefined;
  let subject: DataSurfaceIdentity['subject'];
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
    subject = {
      type: value.subject.type,
      id: value.subject.id,
      ...(value.subject.label === undefined
        ? {}
        : { label: value.subject.label }),
    };
  }
  return {
    surfaceId: value.surfaceId,
    kind: value.kind,
    ...(subject ? { subject } : {}),
  } as DataSurfaceIdentity;
}

function identitySignature(identity: DataSurfaceIdentity): string {
  return JSON.stringify({
    surfaceId: identity.surfaceId,
    kind: identity.kind,
    ...(identity.subject
      ? {
          subject: {
            type: identity.subject.type,
            id: identity.subject.id,
          },
        }
      : {}),
  });
}

function snapshotOf(value: unknown): DataSurfaceSnapshot | undefined {
  try {
    // The normalizer defensively clones state and descriptor arrays. Bound the
    // untrusted wire envelope before it can do that work on a browser ACK.
    assertDataSurfaceEnvelope(value);
    return normalizeDataSurfaceSnapshot(
      value as Parameters<typeof normalizeDataSurfaceSnapshot>[0],
    ) as DataSurfaceSnapshot;
  } catch {
    return undefined;
  }
}

function isAck(value: unknown): value is DataSurfaceCommandAck {
  return Boolean(
    isRecord(value) &&
      value.type === 'data-surface.ack' &&
      value.version === 1 &&
      isString(value.commandId) &&
      isString(value.sessionId) &&
      isString(value.source) &&
      typeof value.expiresAt === 'number' &&
      Number.isFinite(value.expiresAt) &&
      identityOf(value.identity) &&
      typeof value.expectedRevision === 'number' &&
      Number.isSafeInteger(value.expectedRevision) &&
      value.expectedRevision >= 0 &&
      typeof value.ok === 'boolean',
  );
}

function isEvent(value: unknown): value is DataSurfaceBridgeEvent {
  return Boolean(
    isRecord(value) &&
      value.type === 'data-surface.event' &&
      value.version === 1 &&
      isString(value.sessionId) &&
      isString(value.source) &&
      typeof value.sequence === 'number' &&
      Number.isSafeInteger(value.sequence) &&
      value.sequence > 0 &&
      identityOf(value.identity) &&
      typeof value.revision === 'number' &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0 &&
      (value.event === 'registered' ||
        value.event === 'unregistered' ||
        value.event === 'command'),
  );
}

function resultOf(value: unknown): DataSurfaceCommandResult | undefined {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return undefined;
  const allowed = new Set([
    'ok',
    'commandId',
    'identity',
    'revision',
    'snapshot',
    'reason',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (!isString(value.commandId)) return undefined;
  const identity = identityOf(value.identity);
  if (!identity) return undefined;
  if (
    value.revision !== undefined &&
    (!isFiniteInteger(value.revision) || value.revision < 0)
  ) {
    return undefined;
  }
  if (value.ok) {
    if (value.reason !== undefined) return undefined;
  } else if (!isCommandResultReason(value.reason)) {
    return undefined;
  }
  let snapshot: DataSurfaceSnapshot | undefined;
  if (value.snapshot !== undefined) {
    snapshot = snapshotOf(value.snapshot);
    if (!snapshot) return undefined;
    if (
      identitySignature(snapshot.descriptor.identity) !==
        identitySignature(identity) ||
      (value.revision !== undefined && snapshot.revision !== value.revision)
    ) {
      return undefined;
    }
  }
  return {
    ok: value.ok,
    commandId: value.commandId,
    identity,
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  } as DataSurfaceCommandResult;
}

function eventOf(value: unknown): DataSurfaceBridgeEvent | undefined {
  if (!isEvent(value)) return undefined;
  try {
    assertDataSurfaceEnvelope(value);
    const identity = identityOf(value.identity);
    if (!identity) return undefined;
    let command: DataSurfaceVisibleCommand | undefined;
    if (value.command !== undefined) {
      command = normalizeDataSurfaceVisibleCommand(
        value.command,
      ) as DataSurfaceVisibleCommand;
    }
    const result =
      value.result === undefined ? undefined : resultOf(value.result);
    if (value.result !== undefined && result === undefined) return undefined;
    if (value.event === 'command' && (!command || !result)) return undefined;
    if (value.event !== 'command' && (command || result)) return undefined;
    if (
      value.event === 'command' &&
      (result?.revision === undefined ||
        value.revision !== result.revision ||
        (result.ok && result.revision < (command?.expectedRevision ?? 0)))
    ) {
      return undefined;
    }
    if (
      (command &&
        identitySignature(command.identity) !== identitySignature(identity)) ||
      (result &&
        (identitySignature(result.identity) !== identitySignature(identity) ||
          (command !== undefined && result.commandId !== command.commandId)))
    ) {
      return undefined;
    }
    return {
      type: 'data-surface.event',
      version: 1,
      sessionId: value.sessionId,
      source: value.source,
      sequence: value.sequence,
      identity,
      revision: value.revision,
      ...(command === undefined ? {} : { command }),
      ...(result === undefined ? {} : { result }),
      event: value.event,
    };
  } catch {
    return undefined;
  }
}

function fallbackAck(
  command: DataSurfaceVisibleCommand,
  sessionId: string,
  source: string,
  reason: DataSurfaceBridgeFailureReason,
  expiresAt: number,
): DataSurfaceCommandAck {
  return {
    type: 'data-surface.ack',
    version: 1,
    commandId: command.commandId,
    sessionId,
    source,
    expiresAt,
    identity: command.identity,
    expectedRevision: command.expectedRevision,
    ok: false,
    reason,
  };
}

function commandSignature(command: DataSurfaceVisibleCommand): string {
  return JSON.stringify(command);
}

/**
 * Send browser-visible commands from an already-authenticated server turn.
 * `send()` deliberately requires a server callback before any bytes leave the
 * process. It does not accept actor, tenant, or role fields from the caller.
 */
export function createDataSurfaceCommandBridge(
  options: DataSurfaceCommandBridgeOptions,
): DataSurfaceCommandBridge {
  if (
    !isString(options.sessionId) ||
    !isString(options.source) ||
    !isString(options.peerSource)
  ) {
    throw new TypeError('DataSurface bridge session/source ids are required');
  }
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_DATA_SURFACE_BRIDGE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? ttlMs;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > ttlMs
  ) {
    throw new RangeError('Invalid DataSurface bridge bounds');
  }

  type Pending = {
    command: DataSurfaceVisibleCommand;
    request: DataSurfaceCommandRequest;
    expiresAt: number;
    resolve: (ack: DataSurfaceCommandAck) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const pending = new Map<string, Pending>();
  const inflight = new Map<
    string,
    { signature: string; promise: Promise<DataSurfaceCommandAck> }
  >();
  const listeners = new Set<(event: DataSurfaceBridgeEvent) => void>();
  let state: DataSurfaceBridgeConnectionState = 'connected';
  let disposed = false;
  let lastSequence = 0;

  const rejectPending = (reason: 'timeout' | 'disconnected') => {
    for (const [commandId, item] of pending) {
      clearTimeout(item.timer);
      pending.delete(commandId);
      inflight.delete(commandId);
      item.resolve(
        fallbackAck(
          item.command,
          options.sessionId,
          options.peerSource,
          reason,
          item.expiresAt,
        ),
      );
    }
  };

  const validateAck = (
    value: DataSurfaceCommandAck,
    item: Pending,
  ): DataSurfaceCommandAck | undefined => {
    const request = item.request;
    if (
      value.commandId !== request.commandId ||
      value.sessionId !== request.sessionId ||
      value.source !== options.peerSource ||
      value.expiresAt !== request.expiresAt ||
      value.expectedRevision !== request.expectedRevision ||
      identitySignature(value.identity) !== identitySignature(request.identity)
    ) {
      return undefined;
    }
    if (
      value.revision !== undefined &&
      (!isFiniteInteger(value.revision) || value.revision < 0)
    ) {
      return undefined;
    }
    if (value.ok) {
      if (
        value.reason !== undefined ||
        value.revision === undefined ||
        value.snapshot === undefined ||
        (value.ok && value.revision < request.expectedRevision)
      ) {
        return undefined;
      }
    } else if (!isFailureReason(value.reason)) {
      return undefined;
    }
    let snapshot: DataSurfaceSnapshot | undefined;
    if (value.snapshot !== undefined) {
      snapshot = snapshotOf(value.snapshot);
      if (snapshot === undefined) return undefined;
      if (
        identitySignature(snapshot.descriptor.identity) !==
          identitySignature(request.identity) ||
        (value.ok && snapshot.revision < request.expectedRevision) ||
        (value.revision !== undefined && snapshot.revision !== value.revision)
      ) {
        return undefined;
      }
    }
    return {
      type: 'data-surface.ack',
      version: 1,
      commandId: request.commandId,
      sessionId: request.sessionId,
      source: options.peerSource,
      expiresAt: request.expiresAt,
      identity: request.identity,
      expectedRevision: request.expectedRevision,
      ok: value.ok,
      ...(value.revision === undefined ? {} : { revision: value.revision }),
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    };
  };

  const receive = (value: unknown, peer: DataSurfaceBridgePeer) => {
    if (
      disposed ||
      !isPeer(peer) ||
      peer.sessionId !== options.sessionId ||
      peer.source !== options.peerSource
    )
      return;
    if (isAck(value)) {
      if (
        value.sessionId !== options.sessionId ||
        value.source !== options.peerSource
      )
        return;
      const item = pending.get(value.commandId);
      if (!item) return;
      const validated = validateAck(value, item);
      if (!validated) return;
      pending.delete(value.commandId);
      inflight.delete(value.commandId);
      clearTimeout(item.timer);
      // A late success cannot outlive the server-side envelope.
      if (value.expiresAt <= now()) {
        item.resolve(
          fallbackAck(
            item.command,
            options.sessionId,
            options.peerSource,
            'expired',
            item.expiresAt,
          ),
        );
      } else {
        item.resolve(validated);
      }
      return;
    }
    const event = eventOf(value);
    if (!event) return;
    if (
      event.sessionId !== options.sessionId ||
      event.source !== options.peerSource ||
      event.sequence <= lastSequence
    )
      return;
    lastSequence = event.sequence;
    for (const listener of listeners) listener(event);
  };

  const unsubscribeTransport = options.transport.subscribe(receive);
  const unsubscribeStatus = options.transport.subscribeStatus?.((next) => {
    state = next;
    if (next === 'disconnected') rejectPending('disconnected');
  });

  const send = async (
    command: DataSurfaceVisibleCommand,
  ): Promise<DataSurfaceCommandAck> => {
    let normalized: DataSurfaceVisibleCommand;
    try {
      normalized = normalizeDataSurfaceVisibleCommand(
        command,
      ) as DataSurfaceVisibleCommand;
    } catch {
      return fallbackAck(
        command,
        options.sessionId,
        options.peerSource,
        'invalid_request',
        now(),
      );
    }
    if (disposed || state !== 'connected')
      return fallbackAck(
        normalized,
        options.sessionId,
        options.peerSource,
        'disconnected',
        now(),
      );
    let allowed = false;
    try {
      allowed = await options.authorize(normalized);
    } catch {
      allowed = false;
    }
    if (disposed || state !== 'connected')
      return fallbackAck(
        normalized,
        options.sessionId,
        options.peerSource,
        'disconnected',
        now(),
      );
    if (!allowed)
      return fallbackAck(
        normalized,
        options.sessionId,
        options.peerSource,
        'denied',
        now(),
      );

    const signature = commandSignature(normalized);
    const existing = inflight.get(normalized.commandId);
    if (existing) {
      return existing.signature === signature
        ? existing.promise
        : fallbackAck(
            normalized,
            options.sessionId,
            options.peerSource,
            'idempotency_conflict',
            now(),
          );
    }

    const expiresAt = now() + ttlMs;
    const promise = new Promise<DataSurfaceCommandAck>((resolve) => {
      const timer = setTimeout(() => {
        if (!pending.delete(normalized.commandId)) return;
        inflight.delete(normalized.commandId);
        resolve(
          fallbackAck(
            normalized,
            options.sessionId,
            options.peerSource,
            'timeout',
            expiresAt,
          ),
        );
      }, timeoutMs);
      const request: DataSurfaceCommandRequest = {
        type: 'data-surface.command',
        version: 1,
        commandId: normalized.commandId,
        sessionId: options.sessionId,
        source: options.source,
        expiresAt,
        identity: normalized.identity,
        expectedRevision: normalized.expectedRevision,
        controlId: normalized.controlId,
        ...(normalized.payload === undefined
          ? {}
          : { payload: normalized.payload }),
      };
      pending.set(normalized.commandId, {
        command: normalized,
        request,
        expiresAt,
        resolve,
        timer,
      });
      const handleSendFailure = () => {
        if (!pending.delete(normalized.commandId)) return;
        inflight.delete(normalized.commandId);
        clearTimeout(timer);
        resolve(
          fallbackAck(
            normalized,
            options.sessionId,
            options.peerSource,
            'disconnected',
            expiresAt,
          ),
        );
      };
      try {
        Promise.resolve(options.transport.send(request)).catch(
          handleSendFailure,
        );
      } catch {
        handleSendFailure();
      }
    });
    inflight.set(normalized.commandId, { signature, promise });
    if (!pending.has(normalized.commandId))
      inflight.delete(normalized.commandId);
    return promise;
  };

  return {
    sessionId: options.sessionId,
    source: options.source,
    get state() {
      return state;
    },
    send,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeTransport();
      unsubscribeStatus?.();
      rejectPending('disconnected');
      inflight.clear();
      listeners.clear();
    },
  };
}

/** Explicit alias for consumers that want to name the server role. */
export const createServerDataSurfaceBridge = createDataSurfaceCommandBridge;
export const createDataSurfaceBridge = createDataSurfaceCommandBridge;
