import type {
  DataSurfaceIdentity,
  DataSurfaceVisibleCommand,
} from '@happyvertical/smrt-ui/data';
import { describe, expect, it, vi } from 'vitest';
import {
  createDataSurfaceCommandBridge,
  type DataSurfaceBridgeMessage,
  type DataSurfaceBridgePeer,
  type DataSurfaceCommandRequest,
} from './data-surface-bridge.js';

const identity: DataSurfaceIdentity = { surfaceId: 'orders', kind: 'table' };
const command: DataSurfaceVisibleCommand = {
  version: 1,
  commandId: 'command-1',
  identity,
  expectedRevision: 3,
  controlId: 'refresh',
};
const snapshot = {
  version: 1 as const,
  descriptor: {
    version: 1 as const,
    identity,
    schemaVersion: 1,
    label: 'Orders',
    rowKey: 'id',
    columns: [{ id: 'id', label: 'ID', capabilities: ['read' as const] }],
    query: { modes: ['rows' as const], projectableColumnIds: ['id'] },
    controls: [{ id: 'refresh', label: 'Refresh' }],
    actions: [],
    limits: { maxQueryRows: 10, maxQueryBytes: 1000, maxSelectionSize: 10 },
  },
  revision: 4,
  state: {},
  selection: null,
};

function transport() {
  const listeners = new Set<
    (message: unknown, peer: DataSurfaceBridgePeer) => void
  >();
  const statuses = new Set<
    (state: 'connected' | 'disconnected' | 'reconnecting') => void
  >();
  const sent: DataSurfaceBridgeMessage[] = [];
  return {
    sent,
    send: vi.fn((message: DataSurfaceBridgeMessage) => sent.push(message)),
    subscribe(
      listener: (message: unknown, peer: DataSurfaceBridgePeer) => void,
    ) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeStatus(
      listener: (state: 'connected' | 'disconnected' | 'reconnecting') => void,
    ) {
      statuses.add(listener);
      return () => statuses.delete(listener);
    },
    receive(
      message: unknown,
      peer: DataSurfaceBridgePeer = {
        sessionId: 'session-1',
        source: 'browser-1',
      },
    ) {
      for (const listener of listeners) listener(message, peer);
    },
    status(state: 'connected' | 'disconnected' | 'reconnecting') {
      for (const listener of statuses) listener(state);
    },
  };
}

function ack(
  request: DataSurfaceCommandRequest,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: 'data-surface.ack' as const,
    version: 1 as const,
    commandId: request.commandId,
    sessionId: request.sessionId,
    source: 'browser-1',
    expiresAt: request.expiresAt,
    identity,
    expectedRevision: request.expectedRevision,
    ok: true,
    revision: request.expectedRevision + 1,
    snapshot,
    ...overrides,
  };
}

describe('server data-surface bridge', () => {
  it('does not send until server authorization succeeds and resolves on browser ack', async () => {
    const link = transport();
    const bridge = createDataSurfaceCommandBridge({
      transport: link,
      sessionId: 'session-1',
      source: 'server-1',
      peerSource: 'browser-1',
      authorize: vi.fn(async (next) => next.identity.surfaceId === 'orders'),
      now: () => 1_000,
      ttlMs: 1_000,
      timeoutMs: 500,
    });
    const pending = bridge.send(command);
    await Promise.resolve();
    const request = link.sent[0] as DataSurfaceCommandRequest;
    expect(request).toMatchObject({
      sessionId: 'session-1',
      source: 'server-1',
    });
    link.receive(ack(request));
    await expect(pending).resolves.toMatchObject({ ok: true, revision: 4 });
    await expect(
      bridge.send({
        ...command,
        identity: { surfaceId: 'other', kind: 'table' },
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'denied',
    });
  });

  it('returns bounded timeout and disconnect outcomes, and accepts a reconnect retry', async () => {
    vi.useFakeTimers();
    try {
      const link = transport();
      const bridge = createDataSurfaceCommandBridge({
        transport: link,
        sessionId: 'session-1',
        source: 'server-1',
        peerSource: 'browser-1',
        authorize: () => true,
        now: () => 1_000,
        ttlMs: 1_000,
        timeoutMs: 50,
      });
      const timedOut = bridge.send(command);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
      await expect(timedOut).resolves.toMatchObject({
        ok: false,
        reason: 'timeout',
      });

      const disconnected = bridge.send({ ...command, commandId: 'command-2' });
      await Promise.resolve();
      link.status('disconnected');
      await expect(disconnected).resolves.toMatchObject({
        ok: false,
        reason: 'disconnected',
      });

      link.status('connected');
      const retry = bridge.send({ ...command, commandId: 'command-3' });
      await Promise.resolve();
      const retriedRequest = link.sent.at(-1) as DataSurfaceCommandRequest;
      link.receive(ack(retriedRequest));
      await expect(retry).resolves.toMatchObject({ ok: true });
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards mismatched, malformed, and unauthenticated acknowledgements', async () => {
    const link = transport();
    const bridge = createDataSurfaceCommandBridge({
      transport: link,
      sessionId: 'session-1',
      source: 'server-1',
      peerSource: 'browser-1',
      authorize: () => true,
      now: () => 1_000,
      ttlMs: 1_000,
      timeoutMs: 500,
    });
    const pending = bridge.send(command);
    await Promise.resolve();
    const request = link.sent[0] as DataSurfaceCommandRequest;
    link.receive(
      ack(request, { identity: { surfaceId: 'other', kind: 'table' } }),
    );
    link.receive(
      ack(request, { expectedRevision: request.expectedRevision + 1 }),
    );
    link.receive(ack(request, { expiresAt: request.expiresAt + 1 }));
    link.receive(ack(request, { snapshot: {} }));
    link.receive(
      ack(request, {
        snapshot: {
          ...snapshot,
          descriptor: {
            ...snapshot.descriptor,
            columns: [{ id: 'id', label: 'ID', capabilities: ['invalid'] }],
          },
        },
      }),
    );
    link.receive(
      ack(request, {
        snapshot: {
          ...snapshot,
          descriptor: {
            ...snapshot.descriptor,
            limits: { ...snapshot.descriptor.limits, maxQueryRows: 0 },
          },
        },
      }),
    );
    link.receive(
      ack(request, {
        snapshot: {
          ...snapshot,
          descriptor: {
            ...snapshot.descriptor,
            query: { modes: ['rows'], projectableColumnIds: ['unknown'] },
          },
        },
      }),
    );
    link.receive(
      ack(request, {
        snapshot: { ...snapshot, selection: { scope: 'explicit-ids' } },
      }),
    );
    link.receive(
      ack(request, {
        snapshot: { ...snapshot, state: { auth: 'secret' } },
      }),
    );
    link.receive(ack(request, { snapshot: { ...snapshot, extra: true } }));
    link.receive(ack(request), { sessionId: 'session-1', source: 'attacker' });
    link.receive(ack(request), { sessionId: 'attacker', source: 'browser-1' });
    expect(link.sent).toHaveLength(1);

    link.receive(ack(request));
    await expect(pending).resolves.toMatchObject({
      ok: true,
      commandId: request.commandId,
      identity,
      expiresAt: request.expiresAt,
    });
    bridge.dispose();
  });

  it('coalesces concurrent replay of one command id', async () => {
    const link = transport();
    const bridge = createDataSurfaceCommandBridge({
      transport: link,
      sessionId: 'session-1',
      source: 'server-1',
      peerSource: 'browser-1',
      authorize: () => true,
      now: () => 1_000,
      ttlMs: 1_000,
      timeoutMs: 500,
    });
    const first = bridge.send(command);
    await Promise.resolve();
    const second = bridge.send(command);
    await Promise.resolve();
    expect(link.sent).toHaveLength(1);
    link.receive(ack(link.sent[0] as DataSurfaceCommandRequest));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    bridge.dispose();
  });
});
