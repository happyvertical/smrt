import {
  createDataSurfaceRegistry,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
  type DataSurfaceVisibleCommand,
} from '@happyvertical/smrt-ui/data';
import { describe, expect, it, vi } from 'vitest';
import {
  createDataSurfaceBrowserBridge,
  type DataSurfaceBridgeMessage,
  type DataSurfaceBridgePeer,
  type DataSurfaceCommandRequest,
} from '../data-surface.js';

const identity: DataSurfaceIdentity = { surfaceId: 'orders', kind: 'table' };
const descriptor: DataSurfaceDescriptor = {
  version: 1,
  identity,
  schemaVersion: 1,
  label: 'Orders',
  rowKey: 'id',
  columns: [{ id: 'id', label: 'ID', capabilities: ['read'] }],
  query: { modes: ['rows'], projectableColumnIds: ['id'] },
  controls: [{ id: 'refresh', label: 'Refresh' }],
  actions: [],
  limits: { maxQueryRows: 10, maxQueryBytes: 1000, maxSelectionSize: 10 },
};

function request(
  overrides: Partial<DataSurfaceCommandRequest> = {},
): DataSurfaceCommandRequest {
  return {
    type: 'data-surface.command',
    version: 1,
    commandId: 'command-1',
    sessionId: 'session-1',
    source: 'server-1',
    expiresAt: 10_000,
    identity,
    expectedRevision: 1,
    controlId: 'refresh',
    ...overrides,
  };
}

function transport() {
  const messages: DataSurfaceBridgeMessage[] = [];
  const listeners = new Set<
    (message: unknown, peer: DataSurfaceBridgePeer) => void
  >();
  return {
    messages,
    send: vi.fn((message: DataSurfaceBridgeMessage) => {
      messages.push(message);
    }),
    subscribe(
      listener: (message: unknown, peer: DataSurfaceBridgePeer) => void,
    ) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    receive(
      message: unknown,
      peer: DataSurfaceBridgePeer = {
        sessionId: 'session-1',
        source: 'server-1',
      },
    ) {
      for (const listener of listeners) listener(message, peer);
    },
  };
}

function fixture() {
  let revision = 1;
  const execute = vi.fn(() => {
    revision += 1;
  });
  const registry = createDataSurfaceRegistry();
  registry.register({
    descriptor,
    getSnapshot: () => ({ revision, state: { refreshed: revision > 1 } }),
    execute,
  });
  return { registry, execute };
}

const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('data-surface browser bridge', () => {
  it('requires the bound session/source and acknowledges a successful command', async () => {
    const { registry, execute } = fixture();
    const link = transport();
    createDataSurfaceBrowserBridge({
      registry,
      transport: link,
      sessionId: 'session-1',
      source: 'browser-1',
      peerSource: 'server-1',
      now: () => 1_000,
    });

    await link.receive(request({ expiresAt: 2_000 }));
    await drain();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(link.messages.at(-1)).toMatchObject({
      type: 'data-surface.ack',
      commandId: 'command-1',
      sessionId: 'session-1',
      source: 'browser-1',
      ok: true,
    });

    await link.receive(request({ expiresAt: 2_000 }));
    await drain();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not execute stale, expired, or cross-session/source commands', async () => {
    const { registry, execute } = fixture();
    const link = transport();
    createDataSurfaceBrowserBridge({
      registry,
      transport: link,
      sessionId: 'session-1',
      source: 'browser-1',
      peerSource: 'server-1',
      now: () => 1_000,
    });

    await link.receive(request({ commandId: 'stale', expectedRevision: 99 }));
    await link.receive(request({ commandId: 'expired', expiresAt: 500 }));
    await link.receive(request({ commandId: 'session', sessionId: 'other' }));
    await link.receive(request({ commandId: 'source', source: 'other' }));
    await drain();
    expect(execute).not.toHaveBeenCalled();
    expect(
      link.messages
        .filter((message) => message.type === 'data-surface.ack')
        .map((message) => message.reason),
    ).toEqual(
      expect.arrayContaining([
        'stale_revision',
        'expired',
        'session_mismatch',
        'source_mismatch',
      ]),
    );
  });

  it('rejects a command whose wire identity is accompanied by an unauthenticated peer', async () => {
    const { registry, execute } = fixture();
    const link = transport();
    createDataSurfaceBrowserBridge({
      registry,
      transport: link,
      sessionId: 'session-1',
      source: 'browser-1',
      peerSource: 'server-1',
      now: () => 1_000,
    });

    await link.receive(request(), {
      sessionId: 'session-1',
      source: 'attacker',
    });
    await link.receive(request({ commandId: 'session-spoof' }), {
      sessionId: 'attacker',
      source: 'server-1',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(link.messages).toHaveLength(0);
  });

  it('retains every unexpired replay outcome and refuses new commands at capacity', async () => {
    const { registry, execute } = fixture();
    const link = transport();
    createDataSurfaceBrowserBridge({
      registry,
      transport: link,
      sessionId: 'session-1',
      source: 'browser-1',
      peerSource: 'server-1',
      now: () => 1_000,
      maxReplayEntries: 2,
    });

    await link.receive(request({ commandId: 'one', expiresAt: 5_000 }));
    await drain();
    await link.receive(
      request({ commandId: 'two', expectedRevision: 2, expiresAt: 5_000 }),
    );
    await drain();
    await link.receive(
      request({ commandId: 'three', expectedRevision: 3, expiresAt: 5_000 }),
    );
    await drain();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(link.messages.at(-1)).toMatchObject({
      commandId: 'three',
      reason: 'replay_capacity_exceeded',
    });

    await link.receive(request({ commandId: 'one', expiresAt: 5_000 }));
    await drain();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('forwards only monotonic registry events', async () => {
    const { registry } = fixture();
    const link = transport();
    createDataSurfaceBrowserBridge({
      registry,
      transport: link,
      sessionId: 'session-1',
      source: 'browser-1',
      peerSource: 'server-1',
    });
    await link.receive(
      request({ commandId: 'event-command', expiresAt: Date.now() + 1000 }),
    );
    await drain();
    const events = link.messages.filter(
      (message) => message.type === 'data-surface.event',
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.sequence)).toEqual(
      [...events].map((event) => event.sequence).sort((a, b) => a - b),
    );
  });
});
