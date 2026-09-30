/** Dedicated human-review boundary, intentionally absent from the MCP catalog. */
import {
  createDataSurfaceActionAdapter,
  type DataSurfaceServerActionDefinition,
  type DataSurfaceServerActionRequest,
  SqlDataSurfaceActionStateStore,
} from '@happyvertical/smrt-agents/server';
import type { McpAppPrincipal } from '@happyvertical/smrt-app-mcp';
import type { DatabaseInterface } from '@happyvertical/sql';
import { IolausApplicationCollection } from './iolaus-workload.js';

export function createIolausHumanReview(
  db: DatabaseInterface,
  authorize: (principal: McpAppPrincipal | null) => Promise<boolean>,
) {
  const state = new SqlDataSurfaceActionStateStore({ db });
  const adapter = createDataSurfaceActionAdapter({
    state,
    async resolveSurface(run, identity) {
      const principal = {
        id: run.context.userId ?? undefined,
        tenantId: run.context.tenantId ?? undefined,
      };
      const action: DataSurfaceServerActionDefinition = {
        descriptor: {
          id: 'open_review',
          label: 'Open dedicated human review',
          selectionScopes: ['explicit-ids'],
          requiresConfirmation: true,
        },
        inputSchema: {
          type: 'object',
          properties: { sha256: { type: 'string' } },
          required: ['sha256'],
          additionalProperties: false,
        },
        validatePayload: (payload) =>
          payload &&
          typeof payload === 'object' &&
          !Array.isArray(payload) &&
          typeof payload.sha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(payload.sha256) &&
          Object.keys(payload).length === 1
            ? { valid: true }
            : { valid: false },
        confirmation: 'required',
        execution: 'foreground',
        tool: 'iolaus.open_review',
        operation: {
          id: 'iolaus_applications.update',
          collection: 'iolaus_applications',
          action: 'update',
        },
        authorize: () => authorize(principal),
        async eligible(invocation, rowId) {
          const row = await (
            await IolausApplicationCollection.create({ db })
          ).get(String(rowId));
          const payload = invocation.request.payload as
            | { sha256?: string }
            | undefined;
          return {
            eligible: Boolean(
              row &&
                row.ownerId === principal.id &&
                row.tenantId === principal.tenantId &&
                row.materialsDigest === payload?.sha256 &&
                row.materials,
            ),
            reason: 'materials_unavailable',
          };
        },
        async apply(invocation, rowId) {
          if (!(await authorize(principal)))
            throw new Error('Review unavailable');
          if (!db.transaction) throw new Error('Review requires transactions');
          return db.transaction(async (tx) => {
            const row = await (
              await IolausApplicationCollection.create({ db: tx })
            ).get(String(rowId));
            const payload = invocation.request.payload as
              | { sha256?: string }
              | undefined;
            if (
              !row ||
              row.ownerId !== principal.id ||
              row.tenantId !== principal.tenantId ||
              row.materialsDigest !== payload?.sha256
            )
              throw new Error('Review unavailable');
            await tx.query(
              'UPDATE iolaus_applications SET human_review_opened = ?, review_count = review_count + 1 WHERE id = ?',
              true,
              row.id,
            );
            return {
              reviewUrl: `/review/${row.id}`,
              sha256: row.materialsDigest,
              submitted: false,
            };
          });
        },
      };
      return {
        descriptor: {
          version: 1,
          identity,
          schemaVersion: 1,
          label: 'Synthetic applications',
          rowKey: 'id',
          columns: [{ id: 'id', label: 'ID', capabilities: ['read'] }],
          query: { modes: ['rows'], projectableColumnIds: ['id'] },
          controls: [],
          actions: [action.descriptor],
          limits: {
            maxQueryRows: 1,
            maxQueryBytes: 10000,
            maxSelectionSize: 1,
          },
        },
        revision: 1,
        actions: { open_review: action },
      };
    },
    async resolveSelection(_invocation, selection) {
      return {
        revision: 1,
        queryFingerprint: 'immutable-review-v1',
        rowIds: selection.scope === 'explicit-ids' ? selection.rowIds : [],
      };
    },
  });
  /** Caller is the dedicated authenticated human session, never a host response. */
  async function context(principal: McpAppPrincipal) {
    if (!principal.id || !principal.tenantId || !(await authorize(principal)))
      throw new Error('Review unavailable');
    return {
      principal: {
        db,
        principal: {
          runAsUserId: principal.id,
          tenantId: principal.tenantId,
          allowedTools: ['iolaus.open_review'],
        },
        permissions: ['iolaus_applications.update'],
        postgresRls: false,
      },
    };
  }
  return {
    state,
    preview: async (
      request: DataSurfaceServerActionRequest,
      principal: McpAppPrincipal,
    ) => adapter.preview(request, await context(principal)),
    apply: async (
      request: DataSurfaceServerActionRequest,
      principal: McpAppPrincipal,
    ) => adapter.apply(request, await context(principal)),
  };
}
