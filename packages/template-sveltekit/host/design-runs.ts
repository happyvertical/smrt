import { createHash, randomUUID } from 'node:crypto';
import type {
  CookbookToolDefinition,
  CookbookToolName,
  CookbookToolResult,
} from '@happyvertical/smrt-core/cookbook/tools';
import { stableStringify } from '@happyvertical/smrt-core/knowledge';
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
  JobHandle,
  SmrtJobCollection,
  SmrtJobEventCollection,
} from '@happyvertical/smrt-jobs';
import type { DatabaseInterface } from '@happyvertical/sql';
import Ajv from 'ajv/dist/2020.js';

/** Host callbacks retain the normal authenticated assistant dispatcher and approvals. */
export interface CookbookDesignRunsOptions {
  db: DatabaseInterface;
  authorize(ownerId: string, tenantId: string | null): Promise<void>;
  authorizeThread?(
    ownerId: string,
    tenantId: string | null,
    threadId: string,
  ): Promise<void>;
  currentRevision?(ownerId: string, tenantId: string | null): Promise<number>;
  executeOperation?(input: {
    ownerId: string;
    tenantId: string | null;
    threadId: string;
    runId: string;
    actionId: string;
    permissions: readonly string[];
    operation: { tool: CookbookToolName; args: Record<string, unknown> };
    signal: AbortSignal;
  }): Promise<CookbookToolResult>;
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
const definitionPrefix = 'cookbook-design/v4/';
const legacyDurablePrefix = 'cookbook-design/v3/';
const applicableDefinitions = /^cookbook-design\/v[34]\//;
// d3b879bef0: core app.addField inputSchema after the v2 adapter excludes
// approvalId. Derived with core's exported stableStringify, never a copied schema.
const v2AddFieldSchemaPin =
  '0a56ace412f0b4756eb29fb16575da602fb97316fe644ac5ea217278756be9b4';
const fingerprint = (value: unknown) =>
  createHash('sha256').update(stableStringify(value)).digest('hex');

/** Public progress is host-owned; model prose and raw checkpoint notes stay private. */
export function presentCookbookDesignProgress(
  event: DesignRunProgress,
): DesignRunProgress {
  const notes = {
    running: 'I’m working through your request.',
    checking: 'I’m checking the proposed changes.',
    'waiting-approval': 'Your changes are ready for your review.',
    stopped: 'This work is paused.',
    failed: 'I couldn’t finish this request. Please try again.',
    done: 'This work is complete.',
  };
  return {
    runId: event.runId,
    status: event.status,
    pass: {
      index: event.pass.index,
      count: event.pass.count,
      name:
        event.pass.index === 1
          ? 'Checking your request'
          : event.pass.index === 2
            ? 'Planning your changes'
            : 'Checking the proposed changes',
    },
    note:
      event.status === 'failed' &&
      event.note ===
        'No changes were applied. The design needs more information before it can propose a supported change.'
        ? 'No changes were made. I need a little more information.'
        : notes[event.status],
  };
}

/**
 * Concrete cookbook workflow on inference checkpoints and the existing jobs queue.
 * Construct once per database before starting its TaskRunner. Browser requests only
 * admit jobs; model calls occur exclusively through the registered job target.
 */
export function createCookbookDesignRuns(options: CookbookDesignRunsOptions) {
  const ajv = new Ajv({ strict: true, allErrors: true });
  const jobs = SmrtJobCollection.create({ db: options.db });
  const controllers = new Map<string, AbortController>();
  async function enqueue(
    tx: DatabaseInterface,
    state: Readonly<DesignRunState>,
    tenantId: string | null,
  ) {
    await (await jobs).enqueueJob(
      {
        objectType: '@happyvertical/smrt-inference:DesignRunRecord',
        objectId: state.id,
        method: 'execute',
        args: {},
        tenantId,
        dedupeKey: state.id,
        queue: 'default',
        maxAttempts: 1,
        timeout: state.budget.maxDurationMs,
        timeoutBehavior: 'warn',
      },
      { transaction: tx },
    );
  }

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
    const structured = !definition.startsWith('cookbook-design/v1/');
    const operations = structured
      ? ((await options.listOperations?.(ownerId, tenantId)) ?? [])
      : [];
    const versionedOutputSchema = definition.startsWith(definitionPrefix)
      ? {
          ...outputSchema,
          required: [...outputSchema.required, 'personSummary'],
          properties: {
            ...outputSchema.properties,
            personSummary: {
              type: 'string',
              minLength: 1,
              maxLength: 240,
              description:
                'A short plain-language explanation for the person. Never include implementation details. The host validates presentation separately; this field does not grant authority.',
            },
          },
        }
      : outputSchema;
    const schema = structured
      ? {
          ...versionedOutputSchema,
          properties: {
            ...versionedOutputSchema.properties,
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
        await enqueue(tx, state, tenantId);
      },
    });
    const workflow = createDesignRunDriver({
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
        async check(
          output: unknown,
          state: Readonly<DesignRunState>,
          { signal },
        ) {
          // Mechanical validation is repeated after a crash before advancing.
          if (!validateOutput(output))
            throw new Error('Stored design output failed validation');
          const plan = output as {
            operations: Array<{
              tool: CookbookToolName;
              args: Record<string, unknown>;
            }>;
            ready: boolean;
          };
          const final = index === count - 1;
          const input = readInput(state.input);
          if (
            applicableDefinitions.test(definition) &&
            (state.input as { schemaPin?: unknown }).schemaPin !==
              fingerprint(schema)
          )
            throw new Error(
              'The design schema changed; start a new design run',
            );
          const preview = input.profile.previewBeforeApply;
          if (final && applicableDefinitions.test(definition) && !plan.ready)
            return {
              failure:
                'No changes were applied. The design needs more information before it can propose a supported change.',
              input: {
                ...(state.input as Record<string, unknown>),
                previousCheck: { pass: index + 1, ready: false, checked: true },
              },
            };
          if (
            final &&
            applicableDefinitions.test(definition) &&
            plan.ready &&
            plan.operations.length
          ) {
            if (!options.executeOperation)
              throw new Error('Durable design application is unavailable');
            await options.authorize(ownerId, tenantId);
            await options.authorizeThread?.(ownerId, tenantId, input.threadId);
            const pin = (state.input as Record<string, unknown>).applyPin;
            if (pin && pin !== fingerprint({ input, output, schema }))
              throw new Error('The approved design proposal or schema changed');
            const results: CookbookToolResult[] = [];
            for (const [action, operation] of plan.operations.entries()) {
              signal.throwIfAborted();
              if (!input.permissions.includes(operation.tool))
                throw new Error(
                  'Design operation is outside its original permission ceiling',
                );
              const result = await options.executeOperation({
                ownerId,
                tenantId,
                threadId: input.threadId,
                runId: state.id,
                actionId: String(action),
                permissions: input.permissions,
                operation,
                signal,
              });
              if (result.status === 'approval_required') {
                if (typeof result.approvalId !== 'string')
                  throw new Error('Design approval is unavailable');
                return {
                  waitingApproval: true,
                  note: result.summary,
                  input: {
                    ...(state.input as Record<string, unknown>),
                    pendingApprovalId: result.approvalId,
                    previousCheck: {
                      pass: index + 1,
                      ready: true,
                      checked: true,
                    },
                    results,
                  },
                };
              }
              if (result.status !== 'ok') throw new Error(result.summary);
              results.push(result);
            }
            return {
              input: {
                ...(state.input as Record<string, unknown>),
                pendingApprovalId: undefined,
                previousCheck: { pass: index + 1, ready: true, checked: true },
                results,
              },
            };
          }
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
              ...(state.input as Record<string, unknown>),
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
        if (
          applicableDefinitions.test(definition) &&
          (request.input as { schemaPin?: unknown }).schemaPin !==
            fingerprint(schema)
        )
          throw new Error('The design schema changed; start a new design run');
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
      onProgress: (event) =>
        options.onProgress?.(presentCookbookDesignProgress(event)),
    });
    return { ...workflow, validateProposal: validateOutput, schema };
  }

  function passCount(definition: string) {
    const match = /^cookbook-design\/v[1234]\/(\d+)$/.exec(definition);
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
          const run = await driver(ownerId, tenantId, budget.passes);
          return run.start({
            id: randomUUID(),
            ownerId,
            resourceIds: input.resourceIds ?? [],
            input: {
              threadId: input.threadId,
              content: input.content,
              profile: input.profile,
              permissions: [...(input.permissions ?? [])],
              schemaPin: fingerprint(run.schema),
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
        async validateAction(
          id: string,
          actionId: string,
          tool: string,
          args: Record<string, unknown>,
        ) {
          const run = await existing(id);
          const state = await run.status(id, ownerId);
          const output = state.outputs[passCount(state.definition) - 1];
          const input = readInput(state.input);
          if (
            !applicableDefinitions.test(state.definition) ||
            state.phase !== 'check' ||
            state.passIndex !== passCount(state.definition) - 1 ||
            !['waiting-approval', 'running', 'checking'].includes(
              state.status,
            ) ||
            !run.validateProposal(output) ||
            (state.input as { schemaPin?: unknown }).schemaPin !==
              fingerprint(run.schema) ||
            !(output as { ready: boolean }).ready ||
            !/^(0|[1-9]\d*)$/.test(actionId)
          )
            throw new Error('Saved design action changed');
          const operation = (
            output as {
              operations: Array<{
                tool: string;
                args: Record<string, unknown>;
              }>;
            }
          ).operations[Number(actionId)];
          const desired =
            operation?.tool === 'cookbook.apply'
              ? { ...operation.args, apply: true }
              : operation?.args;
          if (
            !operation ||
            operation.tool !== tool ||
            !input.permissions.includes(tool) ||
            fingerprint(desired) !== fingerprint(args)
          )
            throw new Error('Saved design arguments changed');
          const pin = (state.input as { applyPin?: unknown }).applyPin;
          if (pin && pin !== fingerprint({ input, output, schema: run.schema }))
            throw new Error('Saved design proposal changed');
          await options.authorizeThread?.(ownerId, tenantId, input.threadId);
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
          let run = await existing(id);
          let state = await run.status(id, ownerId);
          const input = readInput(state.input);
          if (
            state.definition.startsWith('cookbook-design/v2/') &&
            state.status === 'waiting-approval'
          ) {
            const count = passCount(state.definition);
            const final = state.outputs[count - 1];
            const upgraded = await driver(
              ownerId,
              tenantId,
              count,
              undefined,
              `${legacyDurablePrefix}${count}`,
            );
            const variants = upgraded.schema.properties.operations.items as {
              oneOf?: Array<{
                properties: { tool: { const: string }; args: unknown };
              }>;
            };
            const fieldSchema = variants.oneOf?.find(
              (variant) => variant.properties.tool.const === 'app.addField',
            )?.properties.args;
            if (
              state.phase !== 'model' ||
              state.passIndex !== count ||
              state.outputs.length !== count ||
              state.leaseRevision !== undefined ||
              state.leaseUntil !== undefined ||
              !upgraded.validateProposal(final) ||
              fingerprint(fieldSchema) !== v2AddFieldSchemaPin ||
              !(final as { ready: boolean }).ready ||
              !(final as { operations: unknown[] }).operations.length ||
              !options.authorizeThread ||
              !(
                final as { operations: Array<{ tool: string }> }
              ).operations.every((operation) =>
                input.permissions.includes(operation.tool),
              ) ||
              !(
                final as { operations: Array<{ tool: string }> }
              ).operations.every(
                (operation) => operation.tool === 'app.addField',
              )
            )
              throw new Error(
                'The design proposal is not compatible with durable application',
              );
            await options.authorizeThread(ownerId, tenantId, input.threadId);
            if (!options.currentRevision)
              throw new Error('Live design revision is unavailable');
            const revision = await options.currentRevision(ownerId, tenantId);
            if (
              !(
                final as {
                  operations: Array<{ args: { expectedRevision?: unknown } }>;
                }
              ).operations.every(
                (operation, index) =>
                  operation.args.expectedRevision === revision + index,
              )
            )
              throw new Error(
                'The application revision changed; start a new design run',
              );
            // The same current owning schema must still be offered after auth.
            if (
              fingerprint(upgraded.schema) !==
              fingerprint(
                (
                  await driver(
                    ownerId,
                    tenantId,
                    count,
                    undefined,
                    `${legacyDurablePrefix}${count}`,
                  )
                ).schema,
              )
            )
              throw new Error('The design schema changed');
            const next: DesignRunState = {
              ...state,
              revision: state.revision + 1,
              definition: `${legacyDurablePrefix}${count}`,
              phase: 'check',
              passIndex: count - 1,
              input: {
                ...(state.input as Record<string, unknown>),
                schemaPin: fingerprint(upgraded.schema),
                applyPin: fingerprint({
                  input,
                  output: final,
                  schema: upgraded.schema,
                }),
              },
            };
            if (!options.db.transaction)
              throw new Error('Design runs require transaction support');
            const scope =
              tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
            const migrated = await options.db.transaction(async (tx) =>
              tx.query(
                `UPDATE _smrt_inference_design_runs SET revision = ?, payload = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND ${scope} AND revision = ? AND payload = ? AND NOT EXISTS (SELECT 1 FROM _smrt_jobs WHERE object_id = ? AND object_type = ? AND status IN ('pending', 'running')) RETURNING id`,
                next.revision,
                JSON.stringify(next),
                new Date().toISOString(),
                id,
                ownerId,
                ...(tenantId === null ? [] : [tenantId]),
                state.revision,
                JSON.stringify(state),
                id,
                '@happyvertical/smrt-inference:DesignRunRecord',
              ),
            );
            if (migrated.rows.length !== 1)
              throw new Error('Design run changed; reload its current status');
            state = next;
            run = upgraded;
          }
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
          if (
            applicableDefinitions.test(state.definition) &&
            state.phase === 'check' &&
            ['running', 'checking'].includes(state.status) &&
            state.passIndex === passCount(state.definition) - 1
          ) {
            const output = state.outputs[state.passIndex];
            if (
              !run.validateProposal(output) ||
              !(output as { ready: boolean }).ready ||
              !options.authorizeThread
            )
              throw new Error(
                'Design recovery requires a valid final proposal',
              );
            await options.authorizeThread(ownerId, tenantId, input.threadId);
            const collection = await jobs;
            const candidates = await collection.list({
              where: {
                objectId: id,
                objectType: '@happyvertical/smrt-inference:DesignRunRecord',
                status: 'failed',
              },
              orderBy: 'updated_at DESC',
              limit: 1,
            });
            const prior = candidates[0];
            const events = await SmrtJobEventCollection.create({
              db: options.db,
            });
            const outcomes = await events.listTerminalOutcomes({
              tenantId,
              objectTypes: ['@happyvertical/smrt-inference:DesignRunRecord'],
              limit: 1000,
            });
            if (
              !prior?.id ||
              !outcomes.outcomes.some(
                (event) =>
                  event.jobId === prior.id &&
                  event.attempts === prior.attempts &&
                  event.failureKind === 'stale-recovery',
              )
            )
              throw new Error(
                'The previous worker has not been recovered by TaskRunner',
              );
            if (!options.db.transaction)
              throw new Error('Design runs require transaction support');
            const next = {
              ...state,
              status: 'running' as const,
              revision: state.revision + 1,
            };
            await options.db.transaction(async (tx) => {
              const recovered = await tx.query(
                "UPDATE _smrt_jobs SET updated_at = updated_at WHERE id = ? AND status = 'failed' AND attempts = ? RETURNING id",
                prior.id,
                prior.attempts,
              );
              if (recovered.rows.length !== 1)
                throw new Error('The recovered job changed');
              const scope =
                tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
              const saved = await tx.query(
                `UPDATE _smrt_inference_design_runs SET revision = ?, payload = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND ${scope} AND revision = ? AND payload = ? AND NOT EXISTS (SELECT 1 FROM _smrt_jobs WHERE object_id = ? AND object_type = ? AND status IN ('pending', 'running')) RETURNING id`,
                next.revision,
                JSON.stringify(next),
                new Date().toISOString(),
                id,
                ownerId,
                ...(tenantId === null ? [] : [tenantId]),
                state.revision,
                JSON.stringify(state),
                id,
                '@happyvertical/smrt-inference:DesignRunRecord',
              );
              if (saved.rows.length !== 1)
                throw new Error(
                  'Design run changed; reload its current status',
                );
              await enqueue(tx, next, tenantId);
            });
            return next;
          }
          return run.resume(id, ownerId, budget);
        },
        async resumeAfterApproval(id: string) {
          await options.authorize(ownerId, tenantId);
          const active = await options.db.query(
            "SELECT id FROM _smrt_jobs WHERE object_id = ? AND object_type = ? AND status = 'running'",
            id,
            '@happyvertical/smrt-inference:DesignRunRecord',
          );
          for (const row of active.rows)
            await new JobHandle(String(row.id), await jobs).wait({
              timeout: 30_000,
              pollInterval: 25,
            });
          const run = await existing(id);
          const state = await run.status(id, ownerId);
          if (
            state.status !== 'waiting-approval' ||
            !applicableDefinitions.test(state.definition)
          )
            return state;
          return run.resume(id, ownerId);
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
