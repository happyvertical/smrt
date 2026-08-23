import type {
  DataSurfaceIdentity,
  DataSurfaceVisibleCommand,
} from '@happyvertical/smrt-ui/data';
import { describe, expect, it, vi } from 'vitest';
import {
  createDataSurfaceCommandBridge,
  type DataSurfaceBridgeMessage,
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

function transport() {
  const listeners = new Set<(message: unknown) => void>();
  const statuses = new Set<
    (state: 'connected' | 'disconnected' | 'reconnecting') => void
  >();
  const sent: DataSurfaceBridgeMessage[] = [];
  return {
    sent,
    send: vi.fn((message: DataSurfaceBridgeMessage) => sent.push(message)),
    subscribe(listener: (message: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeStatus(
      listener: (state: 'connected' | 'disconnected' | 'reconnecting') => void,
    ) {
      statuses.add(listener);
      return () => statuses.delete(listener);
    },
    receive(message: unknown) {
      for (const listener of listeners) listener(message);
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
