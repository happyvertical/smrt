import { randomUUID } from 'node:crypto';
import type { CookbookToolDefinition } from '@happyvertical/smrt-core/cookbook/tools';
import {
  createDesignRunDriver,
  createDesignRunStore,
  type DesignPassRequest,
  type DesignPassResult,
  type DesignRunBudget,
  type DesignRunProgress,
  type DesignRunState,
  installDesignRunExecutor,
  type ResolvedWorkProfile,
} from '@happyvertical/smrt-inference/server';
import {
  isRunnerExecutionContext,
  SmrtJobCollection,
} from '@happyvertical/smrt-jobs';
import type { DatabaseInterface } from '@happyvertical/sql';
import Ajv from 'ajv/dist/2020.js';

/** Host callbacks retain the normal authenticated assistant dispatcher and approvals. */
export interface CookbookDesignRunsOptions {
  db: DatabaseInterface;
  authorize(ownerId: string, tenantId: string | null): Promise<void>;
  /** Current core-owned structural schemas, resolved under the live owner. */
  listOperations?(
    ownerId: string,
    tenantId: string | null,
  ): Promise<
    readonly Pick<
      CookbookToolDefinition,
      'name' | 'inputSchema' | 'description'
    >[]
  >;
  executePass(input: {
    ownerId: string;
    tenantId: string | null;
    threadId: string;
    content: string;
    stage: 'profile' | 'propose' | 'revise';
    request: DesignPassRequest;
    profile: ResolvedWorkProfile;
    permissions: readonly string[];
  }): Promise<DesignPassResult>;
  readResource?(
    ownerId: string,
    tenantId: string | null,
    resourceId: string,
    cursor: string | undefined,
    maxChars: number,
  ): Promise<{ data: unknown; nextCursor?: string }>;
  onProgress?(event: DesignRunProgress): void | Promise<void>;
}

const outputSchema = {
  type: 'object',
  required: ['summary', 'checks', 'ready', 'operations'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string', minLength: 1 },
    checks: { type: 'array', items: { type: 'string', minLength: 1 } },
    ready: { type: 'boolean' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tool', 'args'],
        properties: {
          tool: { type: 'string', minLength: 1 },
          args: { type: 'object', additionalProperties: true },
        },
      },
    },
  },
};
const definitionPrefix = 'cookbook-design/v2/';

/**
 * Concrete cookbook workflow on inference checkpoints and the existing jobs queue.
 * Construct once per database before starting its TaskRunner. Browser requests only
 * admit jobs; model calls occur exclusively through the registered job target.
 */
export function createCookbookDesignRuns(options: CookbookDesignRunsOptions) {
  const ajv = new Ajv({ strict: true, allErrors: true });
  const jobs = SmrtJobCollection.create({ db: options.db });
  const controllers = new Map<string, AbortController>();

  async function driver(
    ownerId: string,
    tenantId: string | null,
    count: number,
    claim?: { jobId: string; workerId: string; attempt: number },
    definition = `${definitionPrefix}${count}`,
  ) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 64)
      throw new Error('Design passes must be between 1 and 64');
    // v1 outputs retain their original contract. New runs advertise the actual
    // owning schemas without granting the model any mutation tools.
    const operations = definition.startsWith(definitionPrefix)
      ? ((await options.listOperations?.(ownerId, tenantId)) ?? [])
      : [];
    const schema = definition.startsWith(definitionPrefix)
      ? {
          ...outputSchema,
          properties: {
            ...outputSchema.properties,
            operations: {
              ...outputSchema.properties.operations,
              description:
                'Proposed changes only. Use the exact tool names and arguments below; never MCP wire names or invented tools. Set ready to true when the proposal is complete and its checks pass.',
              items: operations.length
                ? {
                    oneOf: operations.map((operation) => {
                      const args = structuredClone(operation.inputSchema);
                      if (
                        args.properties &&
                        typeof args.properties === 'object'
                      )
                        delete (args.properties as Record<string, unknown>)
                          .approvalId;
                      if (Array.isArray(args.required))
                        args.required = args.required.filter(
                          (key) => key !== 'approvalId',
                        );
                      args.additionalProperties = false;
                      return {
                        type: 'object',
                        additionalProperties: false,
                        required: ['tool', 'args'],
                        description: operation.description,
                        properties: { tool: { const: operation.name }, args },
                      };
                    }),
                  }
                : false,
            },
          },
        }
      : outputSchema;
    const validateOutput = ajv.compile(schema);
    const store = createDesignRunStore({
      db: options.db,
      ownerId,
      tenantId,
      ...(claim
        ? {
            async authorizeWrite(
              tx: DatabaseInterface,
              state: Readonly<DesignRunState>,
            ) {
              const current = await tx.query(
                "UPDATE _smrt_jobs SET updated_at = updated_at WHERE id = ? AND worker_id = ? AND attempts = ? AND object_id = ? AND status = 'running' RETURNING id",
                claim.jobId,
                claim.workerId,
                claim.attempt,
                state.id,
              );
              return current.rows.length === 1;
            },
            async authorizeRelease(
              tx: DatabaseInterface,
              state: Readonly<DesignRunState>,
            ) {
              const current = await tx.query(
                "UPDATE _smrt_jobs SET updated_at = updated_at WHERE id = ? AND worker_id = ? AND attempts = ? AND object_id = ? AND status IN ('running', 'cancelled', 'completed', 'failed') RETURNING id",
                claim.jobId,
                claim.workerId,
                claim.attempt,
                state.id,
              );
              return current.rows.length === 1;
            },
          }
        : {}),
      async enqueue(tx, state) {
        await (await jobs).enqueueJob(
          {
            objectType: '@happyvertical/smrt-inference:DesignRunRecord',
            objectId: state.id,
            method: 'execute',
            args: {},
            tenantId,
            dedupeKey: state.id,
            queue: 'default',
            // Domain checkpoints own resume; never retry a stopped claim.
            maxAttempts: 1,
            timeout: state.budget.maxDurationMs,
            // The driver owns per-pass deadlines and durable cumulative budgets.
            timeoutBehavior: 'warn',
          },
          { transaction: tx },
        );
      },
    });
    return createDesignRunDriver({
      store,
      definition,
      passes: Array.from({ length: count }, (_, index) => ({
        name:
          index === 0
            ? 'Understand the request'
            : index === 1
              ? 'Propose the design'
              : 'Check and revise the design',
        schema,
        async check(output: unknown, state: Readonly<DesignRunState>) {
          // Mechanical validation is repeated after a crash before advancing.
          if (!validateOutput(output))
            throw new Error('Stored design output failed validation');
          const plan = output as { operations: unknown[]; ready: boolean };
          const final = index === count - 1;
          const preview = readInput(state.input).profile.previewBeforeApply;
          return {
            ...(final && (plan.operations.length > 0 || !plan.ready)
              ? {
                  waitingApproval: true,
                  note: !plan.ready
                    ? 'The design needs your review before changes can be applied.'
                    : preview
                      ? 'Your design is ready to review. Apply its proposed changes through the existing app controls.'
                      : 'Your design is ready. Automatic application is blocked because cookbook tools do not yet support safe durable replay. Review and apply the proposed changes through the app controls.',
                }
              : {}),
            input: {
              ...readInput(state.input),
              previousCheck: {
                pass: index + 1,
                ready: (output as { ready: boolean }).ready,
                checked: true,
              },
            },
          };
        },
      })),
      validate(_schema, output) {
        return validateOutput(output)
          ? []
          : (validateOutput.errors ?? []).map(
              (error) => `${error.instancePath || '/'} ${error.message}`,
            );
      },
      async executePass(request) {
        await options.authorize(ownerId, tenantId);
        const input = readInput(request.input);
        return options.executePass({
          ownerId,
          tenantId,
          threadId: input.threadId,
          content: input.content,
          profile: input.profile,
          permissions: input.permissions,
          stage:
            request.pass.index === 1
              ? 'profile'
              : request.pass.index === 2
                ? 'propose'
                : 'revise',
          request,
        });
      },
      async readResource(owner, id, cursor, maxChars) {
        await options.authorize(owner, tenantId);
        if (!options.readResource) throw new Error('Design resource not found');
        return options.readResource(owner, tenantId, id, cursor, maxChars);
      },
      ...(claim
        ? {
            async ownsExecution() {
              const current = await options.db.query(
                "SELECT id FROM _smrt_jobs WHERE id = ? AND worker_id = ? AND attempts = ? AND status = 'running'",
                claim.jobId,
                claim.workerId,
                claim.attempt,
              );
              return current.rows.length === 1;
            },
          }
        : {}),
      onProgress: options.onProgress,
    });
  }

  function passCount(definition: string) {
    const match = /^cookbook-design\/v[12]\/(\d+)$/.exec(definition);
    if (!match) throw new Error('Design run definition changed');
    return Number(match[1]);
  }

  const dispose = installDesignRunExecutor(
    options.db,
    async (record, _args, context) => {
      if (!isRunnerExecutionContext(context))
        throw new Error('Design execution requires TaskRunner ownership');
      const ownerId = record.ownerId;
      const tenantId = record.tenantId;
      if ((context.job.tenantId ?? null) !== tenantId)
        throw new Error('Design run not found');
      await options.authorize(ownerId, tenantId);
      const claim = await options.db.query(
        "SELECT worker_id FROM _smrt_jobs WHERE id = ? AND object_id = ? AND status = 'running'",
        context.job.jobId,
        record.id,
      );
      const workerId = claim.rows[0]?.worker_id;
      if (typeof workerId !== 'string')
        throw new Error('Design job lost ownership');
      const state = JSON.parse(record.payload) as DesignRunState;
      if (state.ownerId !== ownerId || state.id !== record.id)
        throw new Error('Design run not found');
      const controller = new AbortController();
      const abort = () => controller.abort(context.signal.reason);
      if (context.signal.aborted) abort();
      context.signal.addEventListener('abort', abort, { once: true });
      controllers.set(state.id, controller);
      try {
        return await (
          await driver(
            ownerId,
            tenantId,
            passCount(state.definition),
            {
              jobId: context.job.jobId,
              workerId,
              attempt: context.job.attempt,
            },
            state.definition,
          )
        ).run(state.id, ownerId, controller.signal);
      } finally {
        controllers.delete(state.id);
        context.signal.removeEventListener('abort', abort);
      }
    },
  );

  return {
    dispose,
    forOwner(ownerId: string, tenantId: string | null) {
      async function existing(id: string) {
        await options.authorize(ownerId, tenantId);
        // The scoped store enforces owner and tenant before revealing a definition.
        const store = createDesignRunStore({
          db: options.db,
          ownerId,
          tenantId,
          enqueue: async () => {
            throw new Error('Read-only design store');
          },
        });
        const state = await store.load(id, ownerId);
        if (!state) throw new Error('Design run not found');
        return driver(
          ownerId,
          tenantId,
          passCount(state.definition),
          undefined,
          state.definition,
        );
      }
      return {
        async start(input: {
          threadId: string;
          content: string;
          profile: ResolvedWorkProfile;
          resourceIds?: string[];
          /** Captured authenticated permission ceiling; never model supplied. */
          permissions?: readonly string[];
        }) {
          await options.authorize(ownerId, tenantId);
          readInput(input);
          if (input.profile.name !== 'design')
            throw new Error('Design runs require the design profile');
          const budget = input.profile.budgets;
          return (await driver(ownerId, tenantId, budget.passes)).start({
            id: randomUUID(),
            ownerId,
            resourceIds: input.resourceIds ?? [],
            input: {
              threadId: input.threadId,
              content: input.content,
              profile: input.profile,
              permissions: [...(input.permissions ?? [])],
            },
            budget: {
              maxTokens: budget.maxRunTokens,
              maxDurationMs: budget.runTimeoutMs,
              maxCallTokens: budget.maxTurnTokens,
              callTimeoutMs: budget.turnTimeoutMs,
              repairRetries: budget.repairRetries,
              toolResultChars: budget.toolResultChars,
            },
          });
        },
        async latest(threadId: string) {
          await options.authorize(ownerId, tenantId);
          const scope =
            tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
          const rows = await options.db.query(
            `SELECT payload FROM _smrt_inference_design_runs WHERE owner_id = ? AND ${scope} ORDER BY updated_at DESC LIMIT 100`,
            ...(tenantId === null ? [ownerId] : [ownerId, tenantId]),
          );
          for (const row of rows.rows) {
            const state = JSON.parse(String(row.payload)) as DesignRunState;
            if (readInput(state.input).threadId === threadId) return state;
          }
          return null;
        },
        async status(id: string) {
          return (await existing(id)).status(id, ownerId);
        },
        async stop(id: string) {
          const run = await existing(id);
          const state = await run.status(id, ownerId);
          if (state.passIndex >= passCount(state.definition)) return state;
          const result = await run.stop(id, ownerId);
          controllers.get(id)?.abort(new Error('Design run stopped'));
          return result;
        },
        async resume(id: string, budget?: Partial<DesignRunBudget>) {
          const run = await existing(id);
          const state = await run.status(id, ownerId);
          if (
            state.passIndex >= passCount(state.definition) &&
            state.status !== 'done'
          )
            throw new Error(
              'Review the proposed design and apply it through the existing app controls.',
            );
          const active = await options.db.query(
            "SELECT id FROM _smrt_jobs WHERE object_id = ? AND object_type = ? AND status = 'running'",
            id,
            '@happyvertical/smrt-inference:DesignRunRecord',
          );
          if (active.rows.length)
            throw new Error(
              'The current design pass is stopping. Resume when it has stopped.',
            );
          return run.resume(id, ownerId, budget);
        },
      };
    },
  };
}

function readInput(input: unknown): {
  threadId: string;
  content: string;
  profile: ResolvedWorkProfile;
  permissions: string[];
} {
  if (!input || typeof input !== 'object')
    throw new Error('Invalid design input');
  const value = input as Record<string, unknown>;
  if (
    typeof value.threadId !== 'string' ||
    !value.threadId ||
    typeof value.content !== 'string' ||
    !value.content.trim() ||
    !value.profile ||
    typeof value.profile !== 'object' ||
    (value.profile as ResolvedWorkProfile).name !== 'design' ||
    (value.permissions !== undefined &&
      (!Array.isArray(value.permissions) ||
        !value.permissions.every(
          (permission) => typeof permission === 'string',
        )))
  )
    throw new Error('Invalid design input');
  return {
    threadId: value.threadId,
    content: value.content,
    profile: value.profile as ResolvedWorkProfile,
    permissions: (value.permissions as string[] | undefined) ?? [],
  };
}
