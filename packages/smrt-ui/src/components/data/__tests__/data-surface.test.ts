import { describe, expect, it, vi } from 'vitest';
import {
  createDataSurfaceRegistry,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
  type DataSurfaceVisibleCommand,
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

  it('rejects a changed snapshot when its renderer did not advance revision', async () => {
    const { registry } = registerFixture({ advance: false });

    await expect(registry.execute(command())).resolves.toMatchObject({
      ok: false,
      reason: 'non_monotonic_revision',
    });
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
});
