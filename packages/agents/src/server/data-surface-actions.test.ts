import type {
  DataSurfaceActionDescriptor,
  DataSurfaceDescriptor,
  DataSurfaceIdentity,
  DataSurfaceSelectionReference,
} from '@happyvertical/smrt-ui/data';
import { registerPermissionDefinitions } from '@happyvertical/smrt-users';
import { describe, expect, it, vi } from 'vitest';
import type {
  ExecuteAsPrincipalOptions,
  PrincipalRun,
} from '../execute-as-principal.js';
import { executeAsPrincipal } from '../execute-as-principal.js';
import {
  createDataSurfaceActionAdapter,
  type DataSurfaceActionStateStore,
  type DataSurfaceBackgroundActionJob,
  type DataSurfaceServerActionDefinition,
  type DataSurfaceServerActionRequest,
  InMemoryDataSurfaceActionStateStore,
} from './data-surface-actions.js';

const identity: DataSurfaceIdentity = {
  surfaceId: 'orders',
  kind: 'table',
  subject: { type: 'tenant', id: 'tenant-a' },
};

const actionDescriptor: DataSurfaceActionDescriptor = {
  id: 'archive',
  label: 'Archive',
  selectionScopes: ['explicit-ids', 'all-matching'],
  requiresConfirmation: true,
};

const descriptor: DataSurfaceDescriptor = {
  version: 1,
  identity,
  schemaVersion: 1,
  label: 'Orders',
  rowKey: 'id',
  columns: [{ id: 'id', label: 'ID', capabilities: ['read'] }],
  query: { modes: ['rows'], projectableColumnIds: ['id'] },
  controls: [],
  actions: [actionDescriptor],
  limits: { maxQueryRows: 100, maxQueryBytes: 10_000, maxSelectionSize: 10 },
};

function request(
  phase: 'preview' | 'apply',
  overrides: Partial<DataSurfaceServerActionRequest> = {},
): DataSurfaceServerActionRequest {
  return {
    version: 1,
    requestId: `${phase}-1`,
    identity,
    actionId: 'archive',
    phase,
    selection: { scope: 'explicit-ids', rowIds: ['one', 'two'] },
    expectedRevision: 7,
    ...(phase === 'apply' ? { idempotencyKey: 'apply-1' } : {}),
    ...overrides,
  };
}

function harness(options: {
  now?: () => number;
  authorize?: () => boolean;
  eligible?: (rowId: string | number) => { eligible: boolean; reason?: string };
  apply?: (rowId: string | number) => Promise<void> | void;
  revision?: () => number;
  queryFingerprint?: () => string;
  rowIds?: () => Array<string | number>;
  execution?: 'foreground' | 'background';
  enqueue?: (job: DataSurfaceBackgroundActionJob) => Promise<{ jobId: string }>;
  state?: DataSurfaceActionStateStore;
  runAsPrincipal?: typeof executeAsPrincipal;
  confirmation?: DataSurfaceServerActionDefinition['confirmation'];
  surfaceIdentity?: DataSurfaceIdentity;
  requestFingerprintExtension?: () => string;
  mapError?: (error: unknown) => string;
  declaredSelectionScopes?: DataSurfaceActionDescriptor['selectionScopes'];
  resolveDeferredPrincipal?: Parameters<
    typeof createDataSurfaceActionAdapter
  >[0]['resolveDeferredPrincipal'];
}) {
  const calls: ExecuteAsPrincipalOptions[] = [];
  const resolveSelectionCalls: DataSurfaceSelectionReference[] = [];
  const allowedTools = ['orders.archive'];
  const assertOperation = vi.fn();
  const run: PrincipalRun = {
    context: {} as PrincipalRun['context'],
    permissions: ['orders:update'],
    allowedTools,
    isToolAllowed: (tool) => allowedTools.includes(tool),
    assertToolAllowed(tool) {
      if (!allowedTools.includes(tool)) throw new Error('tool denied');
    },
    assertOperation,
  };
  const runAsPrincipal = (async <T>(
    principalOptions: ExecuteAsPrincipalOptions,
    fn: (principalRun: PrincipalRun) => Promise<T>,
  ): Promise<T> => {
    calls.push(principalOptions);
    return fn(run);
  }) as typeof import('../execute-as-principal.js').executeAsPrincipal;
  const definition: DataSurfaceServerActionDefinition = {
    descriptor: {
      ...actionDescriptor,
      requiresConfirmation: (options.confirmation ?? 'required') === 'required',
    },
    inputSchema: { type: 'object', required: ['reason'] },
    validatePayload: (payload) =>
      payload === undefined ||
      (typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload) &&
        typeof payload.reason === 'string')
        ? { valid: true }
        : { valid: false, reason: 'invalid_payload' },
    confirmation: options.confirmation ?? 'required',
    execution: options.execution ?? 'foreground',
    tool: 'orders.archive',
    operation: {
      id: 'orders:update',
      collection: 'orders',
      action: 'update',
    },
    authorize: () => options.authorize?.() ?? true,
    eligible: (_invocation, rowId) =>
      options.eligible?.(rowId) ?? { eligible: true },
    apply: async (_invocation, rowId) => {
      await options.apply?.(rowId);
      return undefined;
    },
  };
  const context = {
    principal: {
      db: 'test.db',
      principal: {
        runAsUserId: 'principal-a',
        tenantId: 'tenant-a',
        allowedTools,
      },
      onBehalfOfUserId: 'originator-a',
      audit: vi.fn(),
    },
  };
  const adapter = createDataSurfaceActionAdapter({
    state: options.state ?? new InMemoryDataSurfaceActionStateStore(),
    now: options.now,
    createToken: () => 'opaque-preview-token',
    runAsPrincipal: options.runAsPrincipal ?? runAsPrincipal,
    resolveSurface: async () => ({
      descriptor: {
        ...descriptor,
        identity: options.surfaceIdentity ?? descriptor.identity,
        actions: [
          {
            ...definition.descriptor,
            selectionScopes:
              options.declaredSelectionScopes ??
              definition.descriptor.selectionScopes,
          },
        ],
      },
      revision: options.revision?.() ?? 7,
      actions: { archive: definition },
    }),
    resolveSelection: async (_invocation, selection) => {
      resolveSelectionCalls.push(selection);
      return {
        revision: options.revision?.() ?? 7,
        queryFingerprint: options.queryFingerprint?.() ?? 'query-v1',
        rowIds:
          options.rowIds?.() ??
          (selection.scope === 'explicit-ids'
            ? selection.rowIds
            : ['one', 'two']),
      };
    },
    ...(options.enqueue
      ? { backgroundQueue: { enqueue: options.enqueue } }
      : {}),
    requestFingerprintExtension: options.requestFingerprintExtension,
    mapError: options.mapError,
    resolveDeferredPrincipal:
      options.resolveDeferredPrincipal ?? (async () => context.principal),
  });
  return { adapter, assertOperation, calls, context, resolveSelectionCalls };
}

it('rejects a selection scope excluded by the mounted surface descriptor', async () => {
  const { adapter, context, resolveSelectionCalls } = harness({
    declaredSelectionScopes: ['explicit-ids'],
  });

  await expect(
    adapter.preview(
      request('preview', {
        selection: { scope: 'all-matching', queryFingerprint: 'query-v1' },
      }),
      context,
    ),
  ).resolves.toMatchObject({ ok: false, reason: 'selection_not_supported' });
  expect(resolveSelectionCalls).toEqual([]);
});

async function previewToken(
  setup: ReturnType<typeof harness>,
): Promise<string> {
  const preview = await setup.adapter.preview(
    request('preview'),
    setup.context,
  );
  expect(preview.ok).toBe(true);
  expect(preview.details).toMatchObject({ count: 2, accepted: 2 });
  if (!preview.confirmationToken) throw new Error('preview token missing');
  return preview.confirmationToken;
}

describe('data-surface action adapter', () => {
  it('binds an opaque preview to the principal and emits attributed audit metadata', async () => {
    const setup = harness({});
    const token = await previewToken(setup);

    expect(token).toBe('opaque-preview-token');
    expect(token).not.toContain('principal-a');
    expect(setup.calls[0]).toMatchObject({
      action: 'data_surface.action.preview',
      onBehalfOfUserId: 'originator-a',
      auditMetadata: {
        surfaceId: 'orders',
        actionId: 'archive',
        requestId: 'preview-1',
      },
    });
    expect(setup.assertOperation).toHaveBeenCalledWith('orders', 'update');

    const apply = request('apply', { confirmationToken: token });
    const otherPrincipal = {
      ...setup.context,
      principal: {
        ...setup.context.principal,
        principal: {
          ...setup.context.principal.principal,
          runAsUserId: 'principal-b',
        },
      },
    };
    await expect(
      setup.adapter.apply(apply, otherPrincipal),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'confirmation_mismatch',
    });
  });

  it('rejects confirmation reuse by a different originator or acting profile', async () => {
    const setup = harness({});
    const boundContext = {
      principal: {
        ...setup.context.principal,
        principal: {
          ...setup.context.principal.principal,
          actsAsProfileId: 'profile-a',
        },
      },
    };
    const preview = await setup.adapter.preview(
      request('preview'),
      boundContext,
    );
    if (!preview.confirmationToken) throw new Error('preview token missing');
    const applyRequest = request('apply', {
      confirmationToken: preview.confirmationToken,
    });

    await expect(
      setup.adapter.apply(applyRequest, {
        principal: {
          ...boundContext.principal,
          onBehalfOfUserId: 'originator-b',
        },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'confirmation_mismatch' });
    await expect(
      setup.adapter.apply(applyRequest, {
        principal: {
          ...boundContext.principal,
          principal: {
            ...boundContext.principal.principal,
            actsAsProfileId: 'profile-b',
          },
        },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'confirmation_mismatch' });
  });

  it('emits the bound attribution through the actual PrincipalAuditSink', async () => {
    const unregister = registerPermissionDefinitions([
      { slug: 'orders.update' },
    ]);
    const audit = vi.fn();
    const setup = harness({ runAsPrincipal: executeAsPrincipal });
    const realContext = {
      principal: {
        ...setup.context.principal,
        db: { type: 'sqlite' as const, url: ':memory:' },
        permissions: ['orders.update'],
        enterTenantContext: false,
        audit,
      },
    };

    try {
      await expect(
        setup.adapter.preview(request('preview'), realContext),
      ).resolves.toMatchObject({ ok: true });
      expect(audit).toHaveBeenCalledWith({
        action: 'data_surface.action.preview',
        actorUserId: 'principal-a',
        onBehalfOfUserId: 'originator-a',
        tenantId: 'tenant-a',
        actsAsProfileId: null,
        metadata: {
          surfaceId: 'orders',
          actionId: 'archive',
          requestId: 'preview-1',
        },
      });
    } finally {
      unregister();
    }
  });

  it('fails closed on payloads that do not satisfy the declared input schema', async () => {
    const setup = harness({});
    await expect(
      setup.adapter.preview(
        request('preview', { payload: { unexpected: true } }),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it('applies actions with confirmation:none without a preview token', async () => {
    const applyRow = vi.fn();
    const setup = harness({ confirmation: 'none', apply: applyRow });

    const applied = await setup.adapter.apply(request('apply'), setup.context);

    expect(applied).toMatchObject({
      ok: true,
      details: { accepted: 2, skipped: 0, failed: 0 },
    });
    expect(applyRow).toHaveBeenCalledTimes(2);
  });

  it('rejects forged and expired confirmation tokens', async () => {
    let now = 10;
    const setup = harness({ now: () => now });
    await expect(
      setup.adapter.apply(
        request('apply', { idempotencyKey: 'missing-confirmation' }),
        setup.context,
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'confirmation_required',
    });
    await expect(
      setup.adapter.apply(
        request('apply', { confirmationToken: 'forged' }),
        setup.context,
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_or_expired_confirmation',
    });

    const token = await previewToken(setup);
    now += 5 * 60 * 1_000;
    await expect(
      setup.adapter.apply(
        request('apply', { confirmationToken: token }),
        setup.context,
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_or_expired_confirmation',
    });
  });

  it('allows a required-confirmation retry with the same key after previewing', async () => {
    const applyRow = vi.fn();
    const setup = harness({ apply: applyRow });
    const idempotencyKey = 'retry-after-preview';

    await expect(
      setup.adapter.apply(request('apply', { idempotencyKey }), setup.context),
    ).resolves.toMatchObject({ ok: false, reason: 'confirmation_required' });

    const token = await previewToken(setup);
    await expect(
      setup.adapter.apply(
        request('apply', { confirmationToken: token, idempotencyKey }),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: true, details: { accepted: 2 } });
    expect(applyRow).toHaveBeenCalledTimes(2);
  });

  it('replays a completed idempotent apply after its confirmation token expires', async () => {
    let now = 10;
    const applyRow = vi.fn();
    const setup = harness({ now: () => now, apply: applyRow });
    const token = await previewToken(setup);
    const applyRequest = request('apply', { confirmationToken: token });

    const first = await setup.adapter.apply(applyRequest, setup.context);
    now += 5 * 60 * 1_000;
    const retry = await setup.adapter.apply(
      { ...applyRequest, requestId: 'apply-retry-2' },
      setup.context,
    );

    expect(first).toMatchObject({ ok: true, details: { accepted: 2 } });
    expect(retry).toEqual({ ...first, requestId: 'apply-retry-2' });
    expect(applyRow).toHaveBeenCalledTimes(2);
  });

  it('treats reordered and duplicated explicit ids as equivalent for a confirmation-bound apply', async () => {
    const applyRow = vi.fn();
    const setup = harness({
      apply: applyRow,
    });
    const previewSelection = {
      scope: 'explicit-ids' as const,
      rowIds: ['two', 'one', 'one'],
    };
    const preview = await setup.adapter.preview(
      request('preview', { selection: previewSelection }),
      setup.context,
    );
    expect(preview.ok).toBe(true);
    if (!preview.confirmationToken) throw new Error('preview token missing');

    const applied = await setup.adapter.apply(
      request('apply', {
        confirmationToken: preview.confirmationToken,
        selection: { scope: 'explicit-ids', rowIds: ['one', 'two'] },
      }),
      setup.context,
    );

    expect(applied).toMatchObject({
      ok: true,
      details: { accepted: 2, skipped: 0, failed: 0 },
    });
    expect(applyRow).toHaveBeenCalledTimes(2);
  });

  it('deduplicates authoritative resolved rows before confirmation and execution', async () => {
    const applyRow = vi.fn();
    const setup = harness({
      apply: applyRow,
      rowIds: () => ['one', 'two', 'two'],
    });
    const preview = await setup.adapter.preview(
      request('preview'),
      setup.context,
    );

    expect(preview).toMatchObject({
      ok: true,
      details: { count: 2, accepted: 2 },
    });
    if (!preview.confirmationToken) throw new Error('preview token missing');

    await expect(
      setup.adapter.apply(
        request('apply', { confirmationToken: preview.confirmationToken }),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: true, details: { accepted: 2 } });
    expect(applyRow).toHaveBeenCalledTimes(2);
  });

  it('does not bind confirmation identity to a subject display label', async () => {
    const previewIdentity: DataSurfaceIdentity = {
      ...identity,
      subject: { type: 'tenant', id: 'tenant-a', label: 'Orders A' },
    };
    const applyIdentity: DataSurfaceIdentity = {
      ...identity,
      subject: { type: 'tenant', id: 'tenant-a', label: 'Orders B' },
    };
    const setup = harness({ surfaceIdentity: previewIdentity });
    const preview = await setup.adapter.preview(
      request('preview', { identity: previewIdentity }),
      setup.context,
    );
    expect(preview.ok).toBe(true);
    if (!preview.confirmationToken) throw new Error('preview token missing');

    const applied = await setup.adapter.apply(
      request('apply', {
        identity: applyIdentity,
        confirmationToken: preview.confirmationToken,
      }),
      setup.context,
    );

    expect(applied).toMatchObject({ ok: true, details: { accepted: 2 } });
  });

  it('caps explicit ids before resolving the authoritative selection', async () => {
    const setup = harness({});
    const rowIds = Array.from({ length: 1_001 }, (_, index) => `row-${index}`);

    const preview = await setup.adapter.preview(
      request('preview', {
        selection: { scope: 'explicit-ids', rowIds },
      }),
      setup.context,
    );

    expect(preview).toMatchObject({ ok: false, reason: 'invalid_request' });
    expect(setup.resolveSelectionCalls).toHaveLength(0);
  });

  it('rechecks authorization, revision, query fingerprint, and resolved rows at apply', async () => {
    let authorized = true;
    let revision = 7;
    let queryFingerprint = 'query-v1';
    let rows = ['one', 'two'];
    const setup = harness({
      authorize: () => authorized,
      revision: () => revision,
      queryFingerprint: () => queryFingerprint,
      rowIds: () => rows,
    });
    const token = await previewToken(setup);
    authorized = false;
    await expect(
      setup.adapter.apply(
        request('apply', { confirmationToken: token }),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'denied' });

    authorized = true;
    revision = 8;
    const revisionSetup = harness({ revision: () => revision });
    revision = 7;
    const revisionToken = await previewToken(revisionSetup);
    revision = 8;
    await expect(
      revisionSetup.adapter.apply(
        request('apply', { confirmationToken: revisionToken }),
        revisionSetup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'stale_preview' });

    const driftSetup = harness({
      queryFingerprint: () => queryFingerprint,
      rowIds: () => rows,
    });
    queryFingerprint = 'query-v1';
    rows = ['one', 'two'];
    const driftToken = await previewToken(driftSetup);
    rows = ['one'];
    await expect(
      driftSetup.adapter.apply(
        request('apply', { confirmationToken: driftToken }),
        driftSetup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'stale_preview' });
  });

  it('returns partial outcomes after fresh eligibility and domain execution checks', async () => {
    let applying = false;
    const mutated: Array<string | number> = [];
    const setup = harness({
      eligible: (rowId) =>
        applying && rowId === 'two'
          ? { eligible: false, reason: 'already archived' }
          : { eligible: true },
      apply: async (rowId) => {
        if (rowId === 'one') mutated.push(rowId);
      },
    });
    const token = await previewToken(setup);
    applying = true;
    const applied = await setup.adapter.apply(
      request('apply', { confirmationToken: token }),
      setup.context,
    );

    expect(mutated).toEqual(['one']);
    expect(applied).toMatchObject({
      ok: true,
      details: {
        accepted: 1,
        skipped: 1,
        failed: 0,
        outcomes: [
          { rowId: 'one', status: 'accepted' },
          { rowId: 'two', status: 'skipped', reason: 'already archived' },
        ],
      },
    });
  });

  it('records a thrown row mutation as a failed partial outcome', async () => {
    const setup = harness({
      apply: async (rowId) => {
        if (rowId === 'two') throw new Error('sensitive internal failure');
      },
    });
    const token = await previewToken(setup);
    const applied = await setup.adapter.apply(
      request('apply', { confirmationToken: token }),
      setup.context,
    );

    expect(applied).toMatchObject({
      ok: true,
      details: {
        accepted: 1,
        skipped: 0,
        failed: 1,
        outcomes: [
          { rowId: 'one', status: 'accepted' },
          { rowId: 'two', status: 'failed', reason: 'execution_failed' },
        ],
      },
    });
    expect(JSON.stringify(applied)).not.toContain('sensitive internal failure');
  });

  it('persists a partial result when eligibility throws after an earlier mutation', async () => {
    let applying = false;
    const applyRow = vi.fn();
    const setup = harness({
      eligible: (rowId) => {
        if (applying && rowId === 'two')
          throw new Error('internal eligibility');
        return { eligible: true };
      },
      apply: applyRow,
    });
    const token = await previewToken(setup);
    applying = true;
    const applyRequest = request('apply', { confirmationToken: token });

    const first = await setup.adapter.apply(applyRequest, setup.context);
    const retry = await setup.adapter.apply(applyRequest, setup.context);

    expect(first).toMatchObject({
      ok: true,
      details: {
        accepted: 1,
        skipped: 0,
        failed: 1,
        outcomes: [
          { rowId: 'one', status: 'accepted' },
          { rowId: 'two', status: 'failed' },
        ],
      },
    });
    expect(retry).toEqual(first);
    expect(applyRow).toHaveBeenCalledTimes(1);
  });

  it('replays identical idempotent applies and rejects token replay under a new key', async () => {
    const applyRow = vi.fn();
    const setup = harness({ apply: applyRow });
    const token = await previewToken(setup);
    const firstRequest = request('apply', { confirmationToken: token });
    const first = await setup.adapter.apply(firstRequest, setup.context);
    const retry = await setup.adapter.apply(firstRequest, setup.context);
    const replay = await setup.adapter.apply(
      request('apply', {
        confirmationToken: token,
        idempotencyKey: 'apply-2',
      }),
      setup.context,
    );

    expect(first.ok).toBe(true);
    expect(retry).toEqual(first);
    expect(applyRow).toHaveBeenCalledTimes(2);
    expect(replay).toMatchObject({
      ok: false,
      reason: 'confirmation_replayed',
    });
  });

  it('starts side effects once across two adapters sharing durable state', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const applyRow = vi.fn(async (rowId: string | number) => {
      if (rowId === 'one') await firstGate;
    });
    const state = new InMemoryDataSurfaceActionStateStore();
    const firstAdapter = harness({ apply: applyRow, state });
    const secondAdapter = harness({ apply: applyRow, state });
    const token = await previewToken(firstAdapter);
    const applyRequest = request('apply', { confirmationToken: token });

    const first = firstAdapter.adapter.apply(
      applyRequest,
      firstAdapter.context,
    );
    const concurrent = secondAdapter.adapter.apply(
      applyRequest,
      secondAdapter.context,
    );
    await vi.waitFor(() => expect(applyRow).toHaveBeenCalledTimes(1));
    releaseFirst?.();

    const [firstResult, concurrentResult] = await Promise.all([
      first,
      concurrent,
    ]);
    expect(concurrentResult).toEqual(firstResult);
    expect(applyRow).toHaveBeenCalledTimes(2);
  });

  it('reports idempotency conflicts for a changed request under the same key', async () => {
    const setup = harness({});
    const token = await previewToken(setup);
    await setup.adapter.apply(
      request('apply', { confirmationToken: token }),
      setup.context,
    );
    const conflict = await setup.adapter.apply(
      request('apply', {
        confirmationToken: token,
        payload: { changed: true },
      }),
      setup.context,
    );
    expect(conflict).toMatchObject({
      ok: false,
      reason: 'idempotency_conflict',
    });
  });

  it('binds a domain request extension into idempotency', async () => {
    let extension = 'target-a';
    const setup = harness({ requestFingerprintExtension: () => extension });
    const token = await previewToken(setup);
    const applyRequest = request('apply', { confirmationToken: token });
    await setup.adapter.apply(applyRequest, setup.context);

    extension = 'target-b';
    await expect(
      setup.adapter.apply(applyRequest, setup.context),
    ).resolves.toMatchObject({ ok: false, reason: 'idempotency_conflict' });
  });

  it('allows the same idempotency key to retry after a non-terminal adapter failure', async () => {
    let applyAuthorizationAttempts = 0;
    const setup = harness({
      authorize: () => {
        applyAuthorizationAttempts += 1;
        if (applyAuthorizationAttempts === 2)
          throw new Error('temporary outage');
        return true;
      },
    });
    const token = await previewToken(setup);
    const applyRequest = request('apply', { confirmationToken: token });

    await expect(
      setup.adapter.apply(applyRequest, setup.context),
    ).rejects.toThrow('temporary outage');
    await expect(
      setup.adapter.apply(applyRequest, setup.context),
    ).resolves.toMatchObject({ ok: true, details: { accepted: 2 } });
  });

  it('accepts background work through the injected queue and rechecks on execution', async () => {
    let queued: DataSurfaceBackgroundActionJob | undefined;
    let releaseExecution: (() => void) | undefined;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const applyRow = vi.fn(async (rowId: string | number) => {
      if (rowId === 'one') await executionGate;
    });
    const setup = harness({
      execution: 'background',
      apply: applyRow,
      enqueue: async (job) => {
        queued = job;
        return { jobId: 'job-1' };
      },
    });
    const token = await previewToken(setup);
    const applyRequest = request('apply', { confirmationToken: token });
    const accepted = await setup.adapter.apply(applyRequest, setup.context);
    const replayed = await setup.adapter.apply(
      { ...applyRequest, requestId: 'background-apply-retry' },
      setup.context,
    );

    expect(accepted).toMatchObject({
      ok: true,
      details: {
        background: true,
        jobId: 'job-1',
        jobRequestId: accepted.requestId,
        accepted: 2,
      },
    });
    expect(replayed).toMatchObject({
      requestId: 'background-apply-retry',
      details: {
        jobId: 'job-1',
        jobRequestId: applyRequest.requestId,
      },
    });
    expect(applyRow).not.toHaveBeenCalled();
    expect(setup.calls).toHaveLength(2);

    if (!queued) throw new Error('background job was not queued');
    const firstDelivery = queued.run();
    const concurrentDelivery = queued.run();
    await vi.waitFor(() => expect(applyRow).toHaveBeenCalledTimes(1));
    releaseExecution?.();
    const [completed, concurrent] = await Promise.all([
      firstDelivery,
      concurrentDelivery,
    ]);
    const redelivery = await queued.run();
    expect(completed).toMatchObject({ ok: true, details: { accepted: 2 } });
    expect(concurrent).toEqual(completed);
    expect(redelivery).toEqual(completed);
    expect(applyRow).toHaveBeenCalledTimes(2);
    expect(setup.calls).toHaveLength(3);
  });

  it('resolves permissions live when deferred work starts', async () => {
    let queued: DataSurfaceBackgroundActionJob | undefined;
    let permissionsRevoked = false;
    const applyRow = vi.fn();
    const runAsPrincipal = (async <T>(
      principalOptions: ExecuteAsPrincipalOptions,
      fn: (principalRun: PrincipalRun) => Promise<T>,
    ): Promise<T> => {
      const allowedTools = ['orders.archive'];
      return fn({
        context: {} as PrincipalRun['context'],
        permissions: principalOptions.permissions ?? [],
        allowedTools,
        isToolAllowed: (tool) => allowedTools.includes(tool),
        assertToolAllowed(tool) {
          if (!allowedTools.includes(tool)) throw new Error('tool denied');
        },
        async assertOperation() {
          if (principalOptions.permissions === undefined && permissionsRevoked)
            throw new Error('permission revoked');
          return {} as Awaited<ReturnType<PrincipalRun['assertOperation']>>;
        },
      });
    }) as typeof executeAsPrincipal;
    const setup = harness({
      execution: 'background',
      apply: applyRow,
      enqueue: async (job) => {
        queued = job;
        return { jobId: 'job-live-permissions' };
      },
      runAsPrincipal,
    });
    Object.assign(setup.context.principal, {
      permissions: ['orders:update'],
    });
    const token = await previewToken(setup);
    await setup.adapter.apply(
      request('apply', { confirmationToken: token }),
      setup.context,
    );

    permissionsRevoked = true;
    await expect(queued?.run()).rejects.toThrow('permission revoked');
    expect(applyRow).not.toHaveBeenCalled();
  });

  it('resolves the persona tool ceiling live when deferred work starts', async () => {
    let queued: DataSurfaceBackgroundActionJob | undefined;
    let allowedTools = ['orders.archive'];
    const applyRow = vi.fn();
    const runAsPrincipal = (async <T>(
      principalOptions: ExecuteAsPrincipalOptions,
      fn: (principalRun: PrincipalRun) => Promise<T>,
    ): Promise<T> => {
      const currentTools = principalOptions.principal.allowedTools ?? [];
      return fn({
        context: {} as PrincipalRun['context'],
        permissions: ['orders:update'],
        allowedTools: currentTools,
        isToolAllowed: (tool) => currentTools.includes(tool),
        assertToolAllowed(tool) {
          if (!currentTools.includes(tool)) throw new Error('tool revoked');
        },
        async assertOperation() {
          return {} as Awaited<ReturnType<PrincipalRun['assertOperation']>>;
        },
      });
    }) as typeof executeAsPrincipal;
    const setup = harness({
      execution: 'background',
      apply: applyRow,
      enqueue: async (job) => {
        queued = job;
        return { jobId: 'job-live-tools' };
      },
      runAsPrincipal,
      resolveDeferredPrincipal: async (reference) => ({
        db: 'test.db',
        principal: {
          runAsUserId: reference.runAsUserId,
          tenantId: reference.tenantId,
          actsAsProfileId: reference.actsAsProfileId,
          allowedTools,
        },
        onBehalfOfUserId: reference.onBehalfOfUserId,
      }),
    });
    const token = await previewToken(setup);
    await setup.adapter.apply(
      request('apply', { confirmationToken: token }),
      setup.context,
    );

    allowedTools = [];
    await expect(queued?.run()).rejects.toThrow('tool revoked');
    expect(applyRow).not.toHaveBeenCalled();
  });

  it('fails deferred execution closed for an incomplete live principal binding', async () => {
    let queued: DataSurfaceBackgroundActionJob | undefined;
    const setup = harness({
      execution: 'background',
      enqueue: async (job) => {
        queued = job;
        return { jobId: 'job-missing-binding' };
      },
      resolveDeferredPrincipal: async (reference) => ({
        db: 'test.db',
        principal: {
          runAsUserId: reference.runAsUserId,
          tenantId: reference.tenantId,
        },
        onBehalfOfUserId: reference.onBehalfOfUserId,
      }),
    });
    const token = await previewToken(setup);
    await setup.adapter.apply(
      request('apply', { confirmationToken: token }),
      setup.context,
    );

    await expect(queued?.run()).rejects.toThrow(
      'principal binding could not be resolved safely',
    );
  });

  it('binds deferred execution to the immutable enqueue principal', async () => {
    let queued: DataSurfaceBackgroundActionJob | undefined;
    const references: Array<{
      runAsUserId: string;
      tenantId: string | null;
      agentClass?: string;
    }> = [];
    const setup = harness({
      execution: 'background',
      enqueue: async (job) => {
        queued = job;
        return { jobId: 'job-bound-principal' };
      },
      resolveDeferredPrincipal: async (reference) => {
        references.push({
          runAsUserId: reference.runAsUserId,
          tenantId: reference.tenantId,
          agentClass: reference.agentClass,
        });
        return {
          db: 'test.db',
          principal: {
            runAsUserId: reference.runAsUserId,
            tenantId: reference.tenantId,
            actsAsProfileId: reference.actsAsProfileId,
            allowedTools: ['orders.archive'],
          },
          onBehalfOfUserId: reference.onBehalfOfUserId,
          agentClass: reference.agentClass,
        };
      },
    });
    setup.context.principal.agentClass = 'orders-agent';
    const token = await previewToken(setup);
    await setup.adapter.apply(
      request('apply', { confirmationToken: token }),
      setup.context,
    );

    setup.context.principal.principal.runAsUserId = 'replacement-user';
    setup.context.principal.principal.tenantId = 'replacement-tenant';
    setup.context.principal.agentClass = 'replacement-agent';

    await expect(queued?.run()).resolves.toMatchObject({ ok: true });
    expect(references).toEqual([
      {
        runAsUserId: 'principal-a',
        tenantId: 'tenant-a',
        agentClass: 'orders-agent',
      },
    ]);
  });

  it('fails deferred execution closed when the live agent class changes', async () => {
    let queued: DataSurfaceBackgroundActionJob | undefined;
    const setup = harness({
      execution: 'background',
      enqueue: async (job) => {
        queued = job;
        return { jobId: 'job-agent-class-mismatch' };
      },
      resolveDeferredPrincipal: async (reference) => ({
        db: 'test.db',
        principal: {
          runAsUserId: reference.runAsUserId,
          tenantId: reference.tenantId,
          actsAsProfileId: reference.actsAsProfileId,
          allowedTools: ['orders.archive'],
        },
        onBehalfOfUserId: reference.onBehalfOfUserId,
        agentClass: 'replacement-agent',
      }),
    });
    setup.context.principal.agentClass = 'orders-agent';
    const token = await previewToken(setup);
    await setup.adapter.apply(
      request('apply', { confirmationToken: token }),
      setup.context,
    );

    await expect(queued?.run()).rejects.toThrow(
      'principal binding could not be resolved safely',
    );
  });

  it('binds confirmation tokens to the previewing agent class', async () => {
    const setup = harness({});
    setup.context.principal.agentClass = 'orders-agent-a';
    const token = await previewToken(setup);

    setup.context.principal.agentClass = 'orders-agent-b';
    await expect(
      setup.adapter.apply(
        request('apply', { confirmationToken: token }),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'confirmation_mismatch' });
  });

  it('isolates idempotency across agent-class authority bindings', async () => {
    const applyRow = vi.fn();
    const setup = harness({ apply: applyRow });
    setup.context.principal.agentClass = 'orders-agent-a';
    const firstToken = await previewToken(setup);
    await expect(
      setup.adapter.apply(
        request('apply', { confirmationToken: firstToken }),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: true });

    setup.context.principal.agentClass = 'orders-agent-b';
    const secondToken = await previewToken(setup);
    await expect(
      setup.adapter.apply(
        request('apply', { confirmationToken: secondToken }),
        setup.context,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(applyRow).toHaveBeenCalledTimes(4);
  });

  it('maps deferred failures into a structured background result', async () => {
    let queued: DataSurfaceBackgroundActionJob | undefined;
    let authorizationChecks = 0;
    const setup = harness({
      execution: 'background',
      authorize: () => {
        authorizationChecks += 1;
        if (authorizationChecks === 3) throw new Error('domain drift');
        return true;
      },
      enqueue: async (job) => {
        queued = job;
        return { jobId: 'job-failure' };
      },
      mapError: () => 'domain_drifted',
    });
    const token = await previewToken(setup);
    await setup.adapter.apply(
      request('apply', { confirmationToken: token }),
      setup.context,
    );

    await expect(queued?.run()).resolves.toMatchObject({
      ok: false,
      reason: 'domain_drifted',
    });
    await expect(queued?.run()).resolves.toMatchObject({
      ok: false,
      reason: 'domain_drifted',
    });
  });

  it('releases unexpected deferred failures so the queue can retry', async () => {
    let queued: DataSurfaceBackgroundActionJob | undefined;
    let authorizationChecks = 0;
    const setup = harness({
      execution: 'background',
      authorize: () => {
        authorizationChecks += 1;
        if (authorizationChecks === 3) throw new Error('transient outage');
        return true;
      },
      enqueue: async (job) => {
        queued = job;
        return { jobId: 'job-retry' };
      },
    });
    const token = await previewToken(setup);
    await setup.adapter.apply(
      request('apply', { confirmationToken: token }),
      setup.context,
    );

    await expect(queued?.run()).rejects.toThrow('transient outage');
    await expect(queued?.run()).resolves.toMatchObject({
      ok: true,
      details: { accepted: 2 },
    });
  });
});
