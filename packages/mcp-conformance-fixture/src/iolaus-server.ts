import {
  createMcpAppServer,
  McpAccessError,
  type McpAppPrincipal,
  type McpWorkflowToolDefinition,
} from '@happyvertical/smrt-app-mcp';
import { McpTaskStore } from '@happyvertical/smrt-jobs';
import {
  openAiDisplayMetadata,
  withOpenAiEntrypoints,
} from '@happyvertical/smrt-mcp-openai';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  IOLAUS_RESOURCE,
  IolausApplicationCollection,
} from './iolaus-workload.js';

/** Application-owned live membership, backed by the caller's ordinary principal directory. */
export function createIolausServer(
  db: DatabaseInterface,
  authorize: (principal: McpAppPrincipal | null) => boolean | Promise<boolean>,
  html: string,
) {
  const collection = () => IolausApplicationCollection.create({ db });
  async function owned(principal: McpAppPrincipal | null, id: unknown) {
    if (!(await authorize(principal)) || typeof id !== 'string')
      throw new McpAccessError(403, 'Workflow unavailable');
    const row = await (await collection()).get(id);
    if (
      !row ||
      row.ownerId !== principal?.id ||
      row.tenantId !== principal.tenantId
    )
      throw new McpAccessError(403, 'Workflow unavailable');
    return row;
  }
  const outputSchema = { type: 'object' as const, additionalProperties: true };
  const result = (data: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data,
  });
  const define = (
    name: string,
    effect: 'read' | 'write',
    execute: McpWorkflowToolDefinition['execute'],
  ): McpWorkflowToolDefinition => ({
    name,
    description: `Synthetic Iolaus ${name}; never sends an application.`,
    effect,
    idempotent: effect === 'read',
    openWorld: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        awaitInput: { type: 'boolean' },
        revision: { type: 'integer' },
        decision: { type: 'string', enum: ['prepare', 'pass'] },
      },
      additionalProperties: false,
    },
    outputSchema,
    ui: { resourceUri: IOLAUS_RESOURCE },
    execute,
  });
  const browse = withOpenAiEntrypoints(
    {
      ...define('iolaus_browse', 'read', async ({ principal }) => {
        if (!(await authorize(principal)))
          throw new McpAccessError(403, 'Workflow unavailable');
        const rows = await (await collection()).list({
          where: { ownerId: principal?.id, tenantId: principal?.tenantId },
        });
        return result({
          applications: rows.map((row) => ({
            id: row.id,
            opportunity: row.opportunity,
          })),
        });
      }),
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    ['global'],
  );
  return createMcpAppServer({
    smrtOptions: () => ({ db }),
    serverInfo: { name: 'synthetic-iolaus', version: '1' },
    allowedClassNames: ['IolausApplication'],
    toolPolicy: ({ principal, tool }) =>
      tool.name.startsWith('iolaus_') ? authorize(principal) : false,
    resourcePolicy: ({ principal }) => authorize(principal),
    resources: [
      {
        uri: IOLAUS_RESOURCE,
        name: 'Synthetic human review',
        version: 'v1',
        html,
        metadata: openAiDisplayMetadata({
          availableDisplayModes: ['inline', 'fullscreen'],
        }),
      },
    ],
    workflowTools: [
      browse,
      define(
        'iolaus_inspect_fit',
        'read',
        async ({ arguments: args, principal }) => {
          const row = await owned(principal, args.id);
          return result({
            id: row.id,
            candidateEvidence: row.candidateEvidence,
            opportunity: row.opportunity,
            fit: 'TypeScript evidence matches synthetic requirement',
            revision: row.revision,
          });
        },
      ),
      define(
        'iolaus_decide',
        'write',
        async ({ arguments: args, principal }) => {
          const row = await owned(principal, args.id);
          if (
            row.materials ||
            args.revision !== row.revision ||
            !['prepare', 'pass'].includes(String(args.decision))
          )
            throw new Error('Invalid or stale decision');
          row.decision = String(args.decision);
          await row.save();
          return result({ decision: row.decision, revision: row.revision });
        },
      ),
      define(
        'iolaus_prepare',
        'write',
        async ({ arguments: args, principal }) => {
          const row = await owned(principal, args.id);
          if (row.decision !== 'prepare' || args.revision !== row.revision)
            throw new Error('Invalid or stale preparation');
          const store = await McpTaskStore.create(db, {
            ownerId: JSON.stringify([
              principal?.tenantId ?? null,
              principal?.id,
            ]),
            tenantId: principal?.tenantId,
            requireAuthorization: true,
          });
          const task = await store.createTask({
            objectType: 'IolausApplication',
            objectId: String(row.id),
            method: 'prepare',
            invocationArgs: [{ awaitInput: args.awaitInput === true }],
            tenantId: principal?.tenantId,
            ...(args.awaitInput === true
              ? {
                  continuation: {
                    recordId: String(row.id),
                    revision: String(row.revision),
                    inputKey: 'notes',
                  },
                }
              : {}),
          });
          return result({ taskId: task.taskId });
        },
      ),
      {
        ...define(
          'iolaus_review_navigation',
          'read',
          async ({ arguments: args, principal }) => {
            if (
              typeof args.url !== 'string' ||
              !/^\/review\/[a-f0-9-]+$/.test(args.url)
            )
              throw new Error('Review unavailable');
            const row = await owned(
              principal,
              args.url.slice('/review/'.length),
            );
            if (!row.materials) throw new Error('Materials unavailable');
            return result({
              id: row.id,
              materials: row.materials,
              sha256: row.materialsDigest,
              revision: row.revision,
              humanReviewUrl: `/review/${row.id}`,
              submitted: false,
            });
          },
        ),
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
          additionalProperties: false,
        },
      },
      define(
        'iolaus_inspect_materials',
        'read',
        async ({ arguments: args, principal }) => {
          const row = await owned(principal, args.id);
          if (!row.materials) throw new Error('Materials unavailable');
          return result({
            id: row.id,
            materials: row.materials,
            sha256: row.materialsDigest,
            revision: row.revision,
            humanReviewUrl: `/review/${row.id}`,
            submitted: false,
          });
        },
      ),
    ],
  });
}
