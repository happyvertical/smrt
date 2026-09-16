/**
 * End-to-end SvelteKit wiring gate for the durable data-surface action queue
 * (#2907): a plain `Request` hits the route helper, which resolves a
 * principal, calls the real `createDataSurfaceActionAdapter`, and — for a
 * background action — a real `@happyvertical/smrt-jobs` queue backed by a
 * real SQLite database, processed by a real `TaskRunner`. This exercises the
 * bulk-scope shape anytown's apply-look action needs: the browser supplies
 * only an anchor row id, and `resolveBulkExplicitIds` expands it server-side
 * against real rows before a single idempotency key covers the whole set.
 */
import {
  field,
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { createTaskRunner } from '@happyvertical/smrt-jobs';
import type {
  DataSurfaceDescriptor,
  DataSurfaceIdentity,
} from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExecuteAsPrincipalOptions,
  PrincipalRun,
} from '../execute-as-principal.js';
import {
  createDataSurfaceActionAdapter,
  type DataSurfaceActionInvocation,
  type DataSurfaceServerActionDefinition,
  InMemoryDataSurfaceActionStateStore,
} from './data-surface-actions.js';
import { createJobsDataSurfaceBackgroundQueue } from './jobs-data-surface-action-queue.js';
import {
  createDataSurfaceActionRouteHandlers,
  resolveBulkExplicitIds,
} from './sveltekit-data-surface-routes.js';

@smrt({ tenantScoped: { mode: 'required' } })
class ReferencePhoto extends SmrtObject {
  @field({ type: 'text' })
  tenantId = '';

  @field({ type: 'text' })
  performerId = '';

  @field({ type: 'text' })
  look = 'unset';

  constructor(
    options: { tenantId?: string; performerId?: string; look?: string } = {},
  ) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.performerId !== undefined)
      this.performerId = options.performerId;
    if (options.look !== undefined) this.look = options.look;
  }
}

class ReferencePhotoCollection extends SmrtCollection<ReferencePhoto> {
  static readonly _itemClass = ReferencePhoto;
}

const identity: DataSurfaceIdentity = {
  surfaceId: 'reference-photos',
  kind: 'table',
  subject: { type: 'tenant', id: 'tenant-a' },
};

const descriptor: DataSurfaceDescriptor = {
  version: 1,
  identity,
  schemaVersion: 1,
  label: 'Reference photos',
  rowKey: 'id',
  columns: [{ id: 'id', label: 'ID', capabilities: ['read'] }],
  query: { modes: ['rows'], projectableColumnIds: ['id'] },
  controls: [],
  actions: [
    {
      id: 'apply-look',
      label: 'Apply look',
      selectionScopes: ['explicit-ids'],
      requiresConfirmation: true,
    },
  ],
  limits: { maxQueryRows: 100, maxQueryBytes: 10_000, maxSelectionSize: 50 },
};

const principalRun: PrincipalRun = {
  context: {} as PrincipalRun['context'],
  permissions: ['reference-photos:update'],
  allowedTools: ['reference-photos.apply-look'],
  isToolAllowed: (tool) => tool === 'reference-photos.apply-look',
  assertToolAllowed(tool) {
    if (tool !== 'reference-photos.apply-look') throw new Error('tool denied');
  },
  assertOperation: async () => undefined,
};

describe('SvelteKit data-surface action route wiring (#2907)', () => {
  let db: DatabaseInterface | undefined;

  afterEach(async () => {
    await db?.close?.();
    db = undefined;
    ObjectRegistry.clearCollectionCache?.();
  });

  it('previews, applies, and durably runs a bulk row action end to end', async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const photos = await ReferencePhotoCollection.create({ db });
    const performerId = 'performer-1';
    const anchor = await photos.create(
      new ReferencePhoto({ tenantId: 'tenant-a', performerId }),
    );
    const sibling1 = await photos.create(
      new ReferencePhoto({ tenantId: 'tenant-a', performerId }),
    );
    const sibling2 = await photos.create(
      new ReferencePhoto({ tenantId: 'tenant-a', performerId }),
    );
    // A different performer's photo must never be swept into the bulk set.
    await photos.create(
      new ReferencePhoto({ tenantId: 'tenant-a', performerId: 'performer-2' }),
    );

    const applyLook: DataSurfaceServerActionDefinition = {
      descriptor: descriptor.actions[0],
      inputSchema: { type: 'object', required: ['look'] },
      validatePayload: (payload) =>
        typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload) &&
        typeof (payload as { look?: unknown }).look === 'string'
          ? { valid: true }
          : { valid: false, reason: 'invalid_payload' },
      confirmation: 'required',
      execution: 'background',
      tool: 'reference-photos.apply-look',
      operation: {
        id: 'reference-photos:update',
        collection: 'reference-photos',
        action: 'update',
      },
      authorize: () => true,
      eligible: () => ({ eligible: true }),
      apply: async (invocation: DataSurfaceActionInvocation, rowId) => {
        const look = (invocation.request.payload as { look: string }).look;
        const row = await photos.get(String(rowId));
        if (!row) throw new Error('row vanished');
        row.look = look;
        await row.save();
        return undefined;
      },
    };

    const resolveDeferredPrincipal =
      async (): Promise<ExecuteAsPrincipalOptions> => ({
        principal: {
          runAsUserId: 'user-1',
          tenantId: 'tenant-a',
          allowedTools: ['reference-photos.apply-look'],
        },
        onBehalfOfUserId: 'user-1',
      });

    const adapter = createDataSurfaceActionAdapter({
      state: new InMemoryDataSurfaceActionStateStore(),
      deferredEnvelopeSigningKey: 'integration-test-signing-key-32-bytes!',
      backgroundHandlerId: 'reference-photos-apply-look-v1',
      resolveDeferredPrincipal,
      runAsPrincipal: (async (options, fn) => fn(principalRun)) as never,
      resolveSurface: async () => ({
        descriptor,
        revision: 1,
        actions: { 'apply-look': applyLook },
      }),
      resolveSelection: async (_invocation, selection) => {
        const rowIds =
          selection.scope === 'explicit-ids'
            ? await resolveBulkExplicitIds(selection.rowIds, {
                expand: async (anchors) => {
                  const rows = await photos.list({
                    where: { performerId },
                  });
                  return [...anchors, ...rows.map((row) => row.id as string)];
                },
              })
            : [];
        return { revision: 1, queryFingerprint: 'query-v1', rowIds };
      },
      backgroundQueue: createJobsDataSurfaceBackgroundQueue({
        db,
        handlerId: 'reference-photos-apply-look-v1',
        execute: (envelope) => adapter.executeDeferred(envelope),
      }),
    });

    const handlers = createDataSurfaceActionRouteHandlers({
      adapter,
      resolvePrincipal: () => ({
        principal: {
          runAsUserId: 'user-1',
          tenantId: 'tenant-a',
          allowedTools: ['reference-photos.apply-look'],
        },
        onBehalfOfUserId: 'user-1',
      }),
    });

    const previewReq = new Request('https://app.example/api/photos/actions', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        requestId: 'req-preview',
        identity,
        actionId: 'apply-look',
        phase: 'preview',
        selection: { scope: 'explicit-ids', rowIds: [anchor.id] },
        payload: { look: 'sunset' },
        expectedRevision: 1,
      }),
    });
    const previewRes = await handlers.preview(previewReq);
    expect(previewRes.status).toBe(200);
    const previewBody = await previewRes.json();
    expect(previewBody.ok).toBe(true);
    expect(previewBody.details.count).toBe(3);
    const confirmationToken = previewBody.confirmationToken as string;
    expect(confirmationToken).toBeTruthy();

    const applyReq = new Request('https://app.example/api/photos/actions', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        requestId: 'req-apply',
        identity,
        actionId: 'apply-look',
        phase: 'apply',
        selection: { scope: 'explicit-ids', rowIds: [anchor.id] },
        payload: { look: 'sunset' },
        expectedRevision: 1,
        idempotencyKey: 'apply-look-anchor-1',
        confirmationToken,
      }),
    });
    const applyRes = await handlers.apply(applyReq);
    expect(applyRes.status).toBe(200);
    const applyBody = await applyRes.json();
    expect(applyBody.ok).toBe(true);
    expect(applyBody.details.background).toBe(true);
    expect(applyBody.details.accepted).toBe(3);
    const jobId = applyBody.details.jobId as string;
    expect(jobId).toBeTruthy();

    // Nothing has mutated yet — the queue only persisted the envelope.
    expect((await photos.get(anchor.id as string))?.look).toBe('unset');

    const runner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      queues: ['data-surface-actions'],
    });
    await runner.initialize(db);
    const completion = new Promise<void>((resolve, reject) => {
      runner.once('job:completed', () => resolve());
      runner.once('job:failed', (_job, error) => reject(error));
      runner.once('runner:error', reject);
    });
    try {
      await runner.start();
      await completion;
    } finally {
      await runner.stop();
    }

    expect((await photos.get(anchor.id as string))?.look).toBe('sunset');
    expect((await photos.get(sibling1.id as string))?.look).toBe('sunset');
    expect((await photos.get(sibling2.id as string))?.look).toBe('sunset');

    // A retried apply with the same idempotency key replays the durable
    // result instead of re-enqueuing or re-mutating.
    const retryApplyReq = new Request(
      'https://app.example/api/photos/actions',
      {
        method: 'POST',
        body: JSON.stringify({
          version: 1,
          requestId: 'req-apply-retry',
          identity,
          actionId: 'apply-look',
          phase: 'apply',
          selection: { scope: 'explicit-ids', rowIds: [anchor.id] },
          payload: { look: 'sunset' },
          expectedRevision: 1,
          idempotencyKey: 'apply-look-anchor-1',
          confirmationToken,
        }),
      },
    );
    const retryRes = await handlers.apply(retryApplyReq);
    expect(retryRes.status).toBe(200);
    const retryBody = await retryRes.json();
    expect(retryBody.details.jobId).toBe(jobId);
  });

  it('returns 401 without ever calling the adapter when principal resolution refuses', async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const state = new InMemoryDataSurfaceActionStateStore();
    let resolveSurfaceCalls = 0;
    const adapter = createDataSurfaceActionAdapter({
      state,
      runAsPrincipal: (async (options, fn) => fn(principalRun)) as never,
      resolveSurface: async () => {
        resolveSurfaceCalls += 1;
        return { descriptor, revision: 1, actions: {} };
      },
      resolveSelection: async () => ({
        revision: 1,
        queryFingerprint: 'q',
        rowIds: [],
      }),
    });
    const handlers = createDataSurfaceActionRouteHandlers({
      adapter,
      resolvePrincipal: () => {
        throw new Error('no session cookie');
      },
    });
    const req = new Request('https://app.example/api/photos/actions', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        requestId: 'req-1',
        identity,
        actionId: 'apply-look',
        phase: 'preview',
        selection: { scope: 'explicit-ids', rowIds: ['x'] },
        expectedRevision: 1,
      }),
    });
    const res = await handlers.preview(req);
    expect(res.status).toBe(401);
    expect(resolveSurfaceCalls).toBe(0);
  });
});
