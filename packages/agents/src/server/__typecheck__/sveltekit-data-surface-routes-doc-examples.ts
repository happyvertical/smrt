/**
 * Type-checked mirror of the code samples in
 * `docs/data-surface-sveltekit-wiring.md` (#2907 review follow-up).
 *
 * This file is never imported or executed — `tsc --noEmit` compiling it as
 * part of the package is the whole point: a doc example that does not
 * type-check here means the guide is wrong. Keep every snippet here in sync
 * with the prose. Real apps do not have `$lib`/SvelteKit-generated types
 * available to this package, so the two SvelteKit-specific route files are
 * represented with the same `(request: Request) => Promise<Response>` shape
 * SvelteKit's generated `RequestHandler` collapses to for a POST-only route —
 * everything upstream of that (the action definition, the adapter wiring,
 * the bulk selection resolver) uses the real framework types.
 */

import type { DataSurfaceDescriptor } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { PrincipalRun } from '../../execute-as-principal.js';
import {
  createDataSurfaceActionAdapter,
  createDataSurfaceActionRouteHandlers,
  createJobsDataSurfaceBackgroundQueue,
  createSqlDataSurfaceActionStateStore,
  type DataSurfaceServerActionDefinition,
  type ResolvedDataSurfaceActions,
  resolveBulkExplicitIds,
} from '../index.js';

// --- stand-ins for the app's own domain model -------------------------------
//
// Deliberately NOT real `@smrt()`-decorated classes: the manifest scanner
// that runs ahead of `tsc` statically registers every `@smrt()` class it
// finds under `src/**`, including a file like this one that is never
// imported or executed. Declared shapes exercise the exact same call
// patterns the doc snippets use (`Collection.create({ db }).get/.save/.list`)
// against the real `DatabaseInterface`, without polluting the package
// manifest with fixture-only objects.

interface CandidateRow {
  status: string;
  save(): Promise<void>;
}

declare const CandidateCollection: {
  create(options: { db: DatabaseInterface }): Promise<{
    get(id: string): Promise<CandidateRow | null>;
  }>;
};

interface ReferencePhotoRow {
  id?: string;
}

declare const ReferencePhotoCollection: {
  create(options: { db: DatabaseInterface }): Promise<{
    list(options: {
      where: Record<string, unknown>;
      limit: number;
    }): Promise<ReferencePhotoRow[]>;
  }>;
};

// --- 1. Define the action (row action) ------------------------------------

export const approveCandidate: DataSurfaceServerActionDefinition = {
  descriptor: {
    id: 'approve',
    label: 'Approve',
    selectionScopes: ['explicit-ids'],
    requiresConfirmation: true,
  },
  inputSchema: null,
  validatePayload: () => ({ valid: true }),
  confirmation: 'required',
  execution: 'foreground',
  tool: 'mam.candidates.approve',
  operation: {
    id: 'candidates:update',
    collection: 'candidates',
    action: 'update',
  },
  authorize: () => true,
  eligible: async (invocation, rowId) => {
    const db = invocation.run.context.database;
    const candidate = db
      ? await (await CandidateCollection.create({ db })).get(String(rowId))
      : null;
    return candidate?.status === 'pending'
      ? { eligible: true }
      : { eligible: false, reason: 'not_pending' };
  },
  apply: async (invocation, rowId) => {
    const db = invocation.run.context.database;
    if (!db) throw new Error('no bound database session');
    const candidates = await CandidateCollection.create({ db });
    const candidate = await candidates.get(String(rowId));
    if (!candidate) throw new Error('candidate vanished');
    candidate.status = 'approved';
    await candidate.save();
    return undefined;
  },
};

// --- 1b. Bulk-scope action: apply-look over a reference-photo set ---------

declare const descriptor: DataSurfaceDescriptor;
declare const applyLookAction: DataSurfaceServerActionDefinition;
declare function currentRevision(run: PrincipalRun): Promise<number>;

export async function resolveReferencePhotosSurface(
  run: PrincipalRun,
): Promise<ResolvedDataSurfaceActions> {
  return {
    descriptor,
    revision: await currentRevision(run),
    actions: { 'apply-look': applyLookAction },
  } satisfies ResolvedDataSurfaceActions;
}

export async function resolveReferencePhotosSelection(
  invocation: Parameters<
    NonNullable<
      Parameters<typeof createDataSurfaceActionAdapter>[0]['resolveSelection']
    >
  >[0],
  selection: Parameters<
    NonNullable<
      Parameters<typeof createDataSurfaceActionAdapter>[0]['resolveSelection']
    >
  >[1],
) {
  if (selection.scope !== 'explicit-ids') {
    return { revision: 1, queryFingerprint: 'n/a', rowIds: [] };
  }
  const db = invocation.run.context.database;
  if (!db) throw new Error('no bound database session');
  const maxRows = descriptor.limits.maxSelectionSize + 1;
  const rowIds = await resolveBulkExplicitIds(selection.rowIds, {
    expand: async (anchors) => {
      const photos = await ReferencePhotoCollection.create({ db });
      const rows = await photos.list({
        where: { 'performerId in': anchors },
        limit: maxRows,
      });
      return rows
        .map((row) => row.id)
        .filter((id): id is string => typeof id === 'string');
    },
  });
  return { revision: 1, queryFingerprint: 'reference-photos-v1', rowIds };
}

// --- 2. Wire the adapter and the durable queue -----------------------------

declare const db: DatabaseInterface;
declare const DATA_SURFACE_ENVELOPE_SIGNING_KEY: string;
declare function resolvePrincipalFromReference(
  reference: unknown,
): ReturnType<
  NonNullable<
    Parameters<
      typeof createDataSurfaceActionAdapter
    >[0]['resolveDeferredPrincipal']
  >
>;

export const referencePhotosAdapter = createDataSurfaceActionAdapter({
  state: createSqlDataSurfaceActionStateStore({ db }),
  resolveSurface: resolveReferencePhotosSurface,
  resolveSelection: resolveReferencePhotosSelection,
  backgroundHandlerId: 'reference-photos-actions-v1',
  deferredEnvelopeSigningKey: DATA_SURFACE_ENVELOPE_SIGNING_KEY,
  resolveDeferredPrincipal: async (reference) =>
    resolvePrincipalFromReference(reference),
  backgroundQueue: createJobsDataSurfaceBackgroundQueue({
    db,
    handlerId: 'reference-photos-actions-v1',
    execute: (envelope) => referencePhotosAdapter.executeDeferred(envelope),
  }),
});

// --- 3. Wire the route ------------------------------------------------------

declare function resolvePrincipalFromEvent(
  request: Request,
): ReturnType<
  Parameters<typeof createDataSurfaceActionRouteHandlers>[0]['resolvePrincipal']
>;

export const referencePhotosActionHandlers =
  createDataSurfaceActionRouteHandlers({
    adapter: referencePhotosAdapter,
    resolvePrincipal: (request) => resolvePrincipalFromEvent(request),
  });

// SvelteKit's generated `RequestHandler` for a POST-only route collapses to
// this shape; the app's real `./$types` import is unavailable to this
// package, so this proves the handlers object itself wires correctly.
type StubRequestHandler = (event: { request: Request }) => Promise<Response>;

export const previewRoutePOST: StubRequestHandler = ({ request }) =>
  referencePhotosActionHandlers.preview(request);

export const applyRoutePOST: StubRequestHandler = ({ request }) =>
  referencePhotosActionHandlers.apply(request);
