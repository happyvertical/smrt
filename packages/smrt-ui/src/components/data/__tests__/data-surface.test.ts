import { describe, expect, it, vi } from 'vitest';
import {
  createDataSurfaceRegistry,
  DATA_SURFACE_MAX_REPLAY_ENTRIES,
  DATA_SURFACE_MAX_REQUEST_BYTES,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
  type DataSurfaceVisibleCommand,
  normalizeDataSurfaceActionRequest,
  normalizeDataSurfaceQueryRequest,
  normalizeDataSurfaceVisibleCommand,
} from '../data-surface.js';

const identity: DataSurfaceIdentity = {
  surfaceId: 'content-library',
  kind: 'table',
  subject: { type: 'site', id: 'docs' },
};

function descriptor(
  overrides: Partial<DataSurfaceDescriptor> = {},
): DataSurfaceDescriptor {
  return {
    version: 1,
    identity,
    schemaVersion: 1,
    label: 'Content library',
    rowKey: 'id',
    columns: [
      { id: 'id', label: 'ID', capabilities: ['read', 'project'] },
      {
        id: 'title',
        label: 'Title',
        capabilities: ['read', 'search', 'filter', 'sort', 'project'],
      },
      {
        id: 'internal',
        label: 'Internal',
        sensitivity: 'sensitive',
        capabilities: [],
      },
    ],
    query: {
      modes: ['rows', 'count', 'facets'],
      projectableColumnIds: ['id', 'title'],
    },
    controls: [{ id: 'set-search', label: 'Search' }],
    actions: [
      {
        id: 'archive',
        label: 'Archive',
        selectionScopes: ['explicit-ids', 'all-matching'],
        requiresConfirmation: true,
      },
    ],
    limits: { maxQueryRows: 50, maxQueryBytes: 10_000, maxSelectionSize: 3 },
    ...overrides,
  };
}

function command(
  overrides: Partial<DataSurfaceVisibleCommand> = {},
): DataSurfaceVisibleCommand {
  return {
    version: 1,
    commandId: 'search-1',
    identity,
    expectedRevision: 3,
    controlId: 'set-search',
    payload: { search: 'Grace' },
    ...overrides,
  };
}

function registerFixture(
  options: { redact?: boolean; advance?: boolean } = {},
) {
  let revision = 3;
  let state = { search: 'Ada', internal: 'not-for-discovery' };
  const execute = vi.fn((next: DataSurfaceVisibleCommand) => {
    state = {
      ...state,
      search:
        next.payload &&
        typeof next.payload === 'object' &&
        !Array.isArray(next.payload)
          ? String(next.payload.search ?? '')
          : '',
    };
    if (options.advance !== false) revision += 1;
  });
  const registry = createDataSurfaceRegistry();
  const unregister = registry.register({
    descriptor: descriptor(),
    getSnapshot: () => ({ revision, state }),
    execute,
    ...(options.redact
      ? {
          redact: (snapshot) => ({
            ...snapshot,
            state: { search: snapshot.state.search ?? '' },
          }),
        }
      : {}),
  });
  return { registry, unregister, execute };
}

describe('data surface registry', () => {
  it('discovers defensive serializable descriptors and snapshots', () => {
    const { registry } = registerFixture();

    const [listed] = registry.list();
    expect(listed).toMatchObject({
      identity,
      rowKey: 'id',
      query: { projectableColumnIds: ['id', 'title'] },
    });
    listed.label = 'mutated by a consumer';
    expect(registry.list()[0]?.label).toBe('Content library');

    const snapshot = registry.inspect(identity);
    expect(snapshot).toMatchObject({
      revision: 3,
      state: { search: 'Ada', internal: 'not-for-discovery' },
      selection: null,
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('rejects duplicate mounted identities rather than replacing them', () => {
    const { registry } = registerFixture();
    expect(() =>
      registry.register({
        descriptor: descriptor(),
        getSnapshot: () => ({ revision: 0, state: {} }),
      }),
    ).toThrow('already registered');
  });

  it('keeps identities with delimiter-like components distinct', () => {
    const firstIdentity: DataSurfaceIdentity = {
      kind: 'table',
      surfaceId: 'x',
      subject: { type: 'y', id: 'z\u0000w' },
    };
    const secondIdentity: DataSurfaceIdentity = {
      kind: 'table',
      surfaceId: 'x\u0000y',
      subject: { type: 'z', id: 'w' },
    };
    const registry = createDataSurfaceRegistry();
    registry.register({
      descriptor: descriptor({ identity: firstIdentity }),
      getSnapshot: () => ({ revision: 0, state: {} }),
    });
    registry.register({
      descriptor: descriptor({ identity: secondIdentity }),
      getSnapshot: () => ({ revision: 0, state: {} }),
    });

    expect(registry.list()).toHaveLength(2);
    registry.unregister(secondIdentity);
    expect(registry.inspect(firstIdentity)?.revision).toBe(0);
    expect(registry.inspect(secondIdentity)).toBeUndefined();
  });

  it('applies the host-owned redaction boundary before inspect results escape', () => {
    const { registry } = registerFixture({ redact: true });
    expect(registry.inspect(identity)?.state).toEqual({ search: 'Ada' });
  });

  it('rejects authority and SQL keys from default and redacted snapshots', () => {
    const registry = createDataSurfaceRegistry();
    expect(() =>
      registry.register({
        descriptor: descriptor(),
        getSnapshot: () => ({ revision: 0, state: { tenantId: 'other' } }),
      }),
    ).toThrow('authority or SQL');

    expect(() =>
      registry.register({
        descriptor: descriptor(),
        getSnapshot: () => ({ revision: 0, state: {} }),
        redact: (snapshot) => ({ ...snapshot, state: { sql: 'select 1' } }),
      }),
    ).toThrow('authority or SQL');
  });

  it('rejects unsupported and stale commands before invoking the surface', async () => {
    const { registry, execute } = registerFixture();

    await expect(
      registry.execute(command({ controlId: 'delete-everything' })),
    ).resolves.toMatchObject({ ok: false, reason: 'unsupported' });
    await expect(
      registry.execute(command({ commandId: 'stale', expectedRevision: 2 })),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'stale_revision',
      revision: 3,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('replays a command idempotently and rejects conflicting reuse of its id', async () => {
    const { registry, execute } = registerFixture();
    const initial = command();

    const first = await registry.execute(initial);
    const replay = await registry.execute(initial);
    const conflict = await registry.execute(
      command({ payload: { search: 'Ada' } }),
    );

    expect(first).toMatchObject({ ok: true, revision: 4 });
    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({
      ok: false,
      reason: 'idempotency_conflict',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('bounds the LRU replay cache for long-lived mounted surfaces', async () => {
    let revision = 0;
    const execute = vi.fn(() => {
      revision += 1;
    });
    const registry = createDataSurfaceRegistry();
    registry.register({
      descriptor: descriptor(),
      getSnapshot: () => ({ revision, state: {} }),
      execute,
    });

    for (let index = 0; index < DATA_SURFACE_MAX_REPLAY_ENTRIES; index += 1) {
      await expect(
        registry.execute(
          command({
            commandId: `command-${index}`,
            expectedRevision: index,
          }),
        ),
      ).resolves.toMatchObject({ ok: true, revision: index + 1 });
    }

    await expect(
      registry.execute(
        command({ commandId: 'command-0', expectedRevision: 0 }),
      ),
    ).resolves.toMatchObject({ ok: true, revision: 1 });
    await expect(
      registry.execute(
        command({
          commandId: `command-${DATA_SURFACE_MAX_REPLAY_ENTRIES}`,
          expectedRevision: DATA_SURFACE_MAX_REPLAY_ENTRIES,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      revision: DATA_SURFACE_MAX_REPLAY_ENTRIES + 1,
    });

    await expect(
      registry.execute(
        command({ commandId: 'command-1', expectedRevision: 1 }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'stale_revision',
      revision: DATA_SURFACE_MAX_REPLAY_ENTRIES + 1,
    });
    await expect(
      registry.execute(
        command({ commandId: 'command-0', expectedRevision: 0 }),
      ),
    ).resolves.toMatchObject({ ok: true, revision: 1 });
    expect(execute).toHaveBeenCalledTimes(DATA_SURFACE_MAX_REPLAY_ENTRIES + 1);
  });

  it('serializes concurrent commands so only one can execute at a revision', async () => {
    let revision = 3;
    let releaseFirst!: () => void;
    const firstExecution = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const execute = vi.fn(async () => {
      await firstExecution;
      revision += 1;
    });
    const registry = createDataSurfaceRegistry();
    registry.register({
      descriptor: descriptor(),
      getSnapshot: () => ({ revision, state: {} }),
      execute,
    });

    const first = registry.execute(command({ commandId: 'first' }));
    const second = registry.execute(command({ commandId: 'second' }));

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    releaseFirst();

    await expect(first).resolves.toMatchObject({ ok: true, revision: 4 });
    await expect(second).resolves.toMatchObject({
      ok: false,
      reason: 'stale_revision',
      revision: 4,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not run a queued command after its surface unregisters', async () => {
    let revision = 3;
    let releaseFirst!: () => void;
    const firstExecution = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const execute = vi.fn(async () => {
      await firstExecution;
      revision += 1;
    });
    const registry = createDataSurfaceRegistry();
    const unregister = registry.register({
      descriptor: descriptor(),
      getSnapshot: () => ({ revision, state: {} }),
      execute,
    });

    const first = registry.execute(command({ commandId: 'first' }));
    const queued = registry.execute(command({ commandId: 'queued' }));

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    unregister();
    releaseFirst();

    await expect(first).resolves.toMatchObject({ ok: true, revision: 4 });
    await expect(queued).resolves.toMatchObject({
      ok: false,
      commandId: 'queued',
      reason: 'not_found',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns execution_failed when handler teardown also breaks snapshots', async () => {
    let tornDown = false;
    const registry = createDataSurfaceRegistry();
    registry.register({
      descriptor: descriptor(),
      getSnapshot: () => {
        if (tornDown) throw new Error('renderer is gone');
        return { revision: 3, state: {} };
      },
      execute: () => {
        tornDown = true;
        throw new Error('handler failed');
      },
    });

    await expect(registry.execute(command())).resolves.toMatchObject({
      ok: false,
      commandId: 'search-1',
      reason: 'execution_failed',
    });
  });

  it('quarantines a changed snapshot when its handler throws before revision advances', async () => {
    let state = { search: 'Ada' };
    const execute = vi.fn(() => {
      state = { search: 'Grace' };
      throw new Error('handler failed');
    });
    const registry = createDataSurfaceRegistry();
    registry.register({
      descriptor: descriptor(),
      getSnapshot: () => ({ revision: 3, state }),
      execute,
    });

    await expect(registry.execute(command())).resolves.toMatchObject({
      ok: false,
      reason: 'non_monotonic_revision',
    });
    await expect(
      registry.execute(command({ commandId: 'blocked-after-failure' })),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'non_monotonic_revision',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('quarantines a changed snapshot until its renderer advances revision', async () => {
    let revision = 3;
    let state = { search: 'Ada' };
    let advance = false;
    const execute = vi.fn(() => {
      state = { search: 'Grace' };
      if (advance) revision += 1;
    });
    const registry = createDataSurfaceRegistry();
    registry.register({
      descriptor: descriptor(),
      getSnapshot: () => ({ revision, state }),
      execute,
    });

    await expect(registry.execute(command())).resolves.toMatchObject({
      ok: false,
      reason: 'non_monotonic_revision',
    });
    await expect(
      registry.execute(command({ commandId: 'blocked-at-revision-3' })),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'non_monotonic_revision',
    });
    expect(execute).toHaveBeenCalledTimes(1);

    revision = 4;
    advance = true;
    await expect(
      registry.execute(
        command({
          commandId: 'after-refresh',
          expectedRevision: 4,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, revision: 5 });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('emits monotonic sequence events and removes unregistered surfaces', async () => {
    const { registry, unregister } = registerFixture();
    const events: Array<{ type: string; sequence: number; revision: number }> =
      [];
    const unsubscribe = registry.subscribe((event) => events.push(event));

    await registry.execute(command());
    unregister();
    unsubscribe();

    expect(
      events.map(({ type, sequence, revision }) => ({
        type,
        sequence,
        revision,
      })),
    ).toEqual([
      { type: 'command', sequence: 2, revision: 4 },
      { type: 'unregistered', sequence: 3, revision: 4 },
    ]);
    expect(registry.inspect(identity)).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('isolates subscriber failures from registry operations', async () => {
    const { registry, execute } = registerFixture();
    registry.subscribe(() => {
      throw new Error('transport failed');
    });

    await expect(registry.execute(command())).resolves.toMatchObject({
      ok: true,
      revision: 4,
    });
    expect(execute).toHaveBeenCalledTimes(1);

    const secondIdentity = { ...identity, surfaceId: 'secondary-surface' };
    expect(() =>
      registry.register({
        descriptor: descriptor({ identity: secondIdentity }),
        getSnapshot: () => ({ revision: 0, state: {} }),
      }),
    ).not.toThrow();
    expect(() => registry.unregister(secondIdentity)).not.toThrow();
  });

  it('validates bounded query and preview/apply action envelopes without executing them', () => {
    const { registry } = registerFixture();

    expect(
      registry.validateQuery({
        version: 1,
        requestId: 'rows-1',
        identity,
        kind: 'rows',
        limit: 25,
        projection: ['title', 'id'],
      }),
    ).toEqual({ ok: true });
    expect(
      registry.validateQuery({
        version: 1,
        requestId: 'rows-too-large',
        identity,
        kind: 'rows',
        limit: 51,
      }),
    ).toEqual({ ok: false, reason: 'limit_exceeded' });
    expect(
      registry.validateQuery({
        version: 1,
        requestId: 'rows-hidden',
        identity,
        kind: 'rows',
        limit: 1,
        projection: ['internal'],
      }),
    ).toEqual({ ok: false, reason: 'projection_not_allowed' });
    expect(
      registry.validateAction({
        version: 1,
        requestId: 'archive-preview',
        identity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'explicit-ids', rowIds: ['b', 'a', 'a'] },
      }),
    ).toEqual({ ok: true });
    expect(
      registry.validateAction({
        version: 1,
        requestId: 'archive-apply',
        identity,
        actionId: 'archive',
        phase: 'apply',
        selection: { scope: 'explicit-ids', rowIds: ['a'] },
      }),
    ).toEqual({ ok: false, reason: 'confirmation_required' });
  });

  it('enforces the descriptor query-byte limit using the normalized UTF-8 envelope', () => {
    const request = {
      version: 1 as const,
      requestId: 'unicode-cursor',
      identity,
      kind: 'rows' as const,
      limit: 1,
      cursor: 'é',
    };
    const maxQueryBytes = new TextEncoder().encode(
      JSON.stringify(normalizeDataSurfaceQueryRequest(request)),
    ).byteLength;
    const registry = createDataSurfaceRegistry();
    registry.register({
      descriptor: descriptor({
        limits: { maxQueryRows: 50, maxQueryBytes, maxSelectionSize: 3 },
      }),
      getSnapshot: () => ({ revision: 0, state: {} }),
    });

    expect(registry.validateQuery(request)).toEqual({ ok: true });
    expect(registry.validateQuery({ ...request, cursor: 'éé' })).toEqual({
      ok: false,
      reason: 'limit_exceeded',
    });
  });

  it('rejects SQL and authority values at the browser-contract boundary', () => {
    expect(() =>
      normalizeDataSurfaceVisibleCommand(
        command({ payload: { sql: 'select * from content' } }),
      ),
    ).toThrow('authority or SQL');
    expect(() =>
      normalizeDataSurfaceVisibleCommand(
        command({ payload: { tenantId: 'other-tenant' } }),
      ),
    ).toThrow('authority or SQL');
  });

  it('rejects parsed prototype keys at every browser-contract boundary', () => {
    const prototypePayload = JSON.parse('{"__proto__":{"tenantId":"other"}}');
    expect(() =>
      normalizeDataSurfaceVisibleCommand(
        command({ payload: prototypePayload }),
      ),
    ).toThrow('prototype key');
    expect(() =>
      normalizeDataSurfaceActionRequest({
        version: 1,
        requestId: 'prototype-action',
        identity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
        payload: prototypePayload,
      }),
    ).toThrow('prototype key');

    const registry = createDataSurfaceRegistry();
    expect(() =>
      registry.register({
        descriptor: descriptor(),
        getSnapshot: () => ({
          revision: 0,
          state: JSON.parse('{"__proto__":{"tenantId":"other"}}'),
        }),
      }),
    ).toThrow('prototype key');
  });

  it('bounds command and action envelopes before dispatch', () => {
    const oversized = 'x'.repeat(DATA_SURFACE_MAX_REQUEST_BYTES);
    expect(() =>
      normalizeDataSurfaceVisibleCommand(
        command({ payload: { value: oversized } }),
      ),
    ).toThrow('UTF-8 bytes');
    expect(() =>
      normalizeDataSurfaceActionRequest({
        version: 1,
        requestId: 'oversized-action',
        identity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
        payload: { value: oversized },
      }),
    ).toThrow('UTF-8 bytes');
    expect(() =>
      normalizeDataSurfaceActionRequest({
        version: 1,
        requestId: 'many-row-ids',
        identity,
        actionId: 'archive',
        phase: 'preview',
        selection: {
          scope: 'explicit-ids',
          rowIds: Array.from({ length: 1_001 }, () => 'duplicate'),
        },
      }),
    ).toThrow('more than 1000 row ids');
  });
});
