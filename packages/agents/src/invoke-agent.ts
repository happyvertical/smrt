/**
 * invoke-agent — agent orchestration via principal delegation (L3 of the
 * learning-agents epic, #1892).
 *
 * A conversational (orchestrator) agent invokes a worker agent through a
 * standard **`invoke-agent` tool** — gated by the persona's `allowedTools` like
 * any other tool. The tool hands the work to a worker **under the orchestrator's
 * own principal** (`runAsUserId` + `tenantId`), the worker runs via
 * {@link executeAsPrincipal} under that same principal, and reports completion
 * back into the conversation via a **correlated completion dispatch**.
 *
 * This is deliberately **not a new engine**. It is the `invoke-agent` tool plus
 * a completion-dispatch convention on top of the machinery that already ships:
 *
 * - {@link executeAsPrincipal} runs the worker as the delegated principal, so
 *   the worker's authority is the originating user's live RBAC — never the
 *   worker's own — and every action audits on-behalf-of that user.
 * - The {@link DelegationEnvelope} makes the principal **immutable along the
 *   chain** (a worker cannot invoke a further worker under a broader principal)
 *   and **bounds delegation depth**.
 * - The DispatchBus carries both the (optional) async invoke signal and the
 *   correlated completion, so a worker's result can be surfaced back into the
 *   conversation.
 *
 * The **transport is pluggable**. The default {@link inlineInvokeAgentTransport}
 * runs the worker in-process and returns the completion as the tool observation
 * (so it surfaces in the same turn). {@link createDispatchInvokeTransport} emits
 * a DispatchBus `agent.invoke` signal a worker processes out of band
 * ({@link processAgentInvocations}); a job-queue transport (enqueue on the
 * `agents` queue) is a consumer-supplied `InvokeAgentTransport` — orchestration
 * never hard-depends on `@happyvertical/smrt-jobs`, which sits *below* agents in
 * the dependency graph.
 *
 * @module
 */

import type { AITool } from '@happyvertical/ai';
import { createLogger, type Logger } from '@happyvertical/logger';
import type { DispatchBus, SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  assertWithinDelegationDepth,
  type DelegationEnvelope,
  deriveDelegationEnvelope,
} from './delegation.js';
import {
  executeAsPrincipal,
  type PrincipalAuditSink,
  type PrincipalRun,
} from './execute-as-principal.js';

/** Catalog slug + permission id of the standard invoke-agent tool. */
export const INVOKE_AGENT_TOOL_SLUG = 'agents.invoke';

/**
 * Provider-safe function name the model receives for the invoke-agent tool.
 * Catalog slugs contain a `.` which some providers (OpenAI) reject in function
 * names; the loop resolves a call by either the slug or this name.
 */
export const INVOKE_AGENT_FUNCTION_NAME = 'agents-invoke';

/** DispatchBus signal a worker is invoked through in the async transport. */
export const AGENT_INVOKE_SIGNAL = 'agent.invoke';

/** DispatchBus signal a worker emits to report completion, correlated by id. */
export const AGENT_COMPLETED_SIGNAL = 'agent.completed';

/**
 * A tool executed under a {@link PrincipalRun} that is not a manifest CRUD
 * operation — e.g. the orchestration invoke-agent tool. It carries its own AI
 * definition and handler, and is offered through the conversational tool loop
 * alongside manifest tools, gated by the same fail-closed `allowedTools`.
 *
 * Defined here (in `@happyvertical/smrt-agents`) rather than in the chat loop so
 * the acyclic `chat → agents` dependency direction is preserved: the loop
 * imports this contract, agents produces implementations of it.
 */
export interface PrincipalTool {
  /** Tool name + permission slug, gated by the persona's `allowedTools`. */
  slug: string;
  /** The provider tool definition offered to the model. */
  aiTool: AITool;
  /** Execute the tool under the principal run (should re-assert its own gate). */
  execute(ctx: PrincipalToolContext): Promise<unknown>;
}

/** Context handed to a {@link PrincipalTool.execute}. */
export interface PrincipalToolContext {
  /** The principal run whose context bounds this execution. */
  run: PrincipalRun;
  /** Parsed tool arguments. */
  args: Record<string, unknown>;
  /** The database handle for side-door operations. */
  db?: SmrtClassOptions['db'];
}

/** A worker invocation handed to a {@link WorkerRunner}. */
export interface WorkerInvocation {
  /** The principal run the worker executes within (the delegated principal). */
  run: PrincipalRun;
  /** The delegation envelope (principal, depth, correlation). */
  envelope: DelegationEnvelope;
  /** The target worker agent class. */
  agentClass: string;
  /** The task payload handed to the worker. */
  task: Record<string, unknown>;
  /** The database handle for the worker's operations. */
  db?: SmrtClassOptions['db'];
}

/**
 * Performs a worker's actual work under the delegated principal. Injected so
 * orchestration stays decoupled from *what* a worker does (run an `Agent`, run a
 * nested persona conversation, call a domain method); the runner receives a
 * {@link PrincipalRun} already bound to the originating user's permissions.
 */
export type WorkerRunner = (invocation: WorkerInvocation) => Promise<unknown>;

/**
 * A worker's completion, correlated back to the invocation that produced it.
 */
export interface AgentCompletion {
  /** Correlates this completion to the invocation. */
  correlationId: string;
  /** The worker agent class that ran. */
  agentClass: string;
  /** The originating user the worker acted on behalf of. */
  onBehalfOfUserId: string;
  /** Whether the worker's work succeeded. */
  ok: boolean;
  /** The worker's result, when it succeeded. */
  result?: unknown;
  /** The error message, when it failed. */
  error?: string;
}

/** The outcome the invoke-agent tool returns to the conversation. */
export interface InvokeAgentResult {
  /**
   * `completed` / `failed` for an in-process (inline) invocation whose result is
   * surfaced in the same turn; `enqueued` for an async transport whose
   * completion is surfaced later via {@link surfaceAgentCompletions}.
   */
  status: 'completed' | 'failed' | 'enqueued';
  /** Correlates a later completion dispatch back to this invocation. */
  correlationId: string;
  /** The worker agent class invoked. */
  agentClass: string;
  /** The delegation depth of the invoked worker. */
  depth: number;
  /** The worker's result, when it completed in-process. */
  result?: unknown;
  /** The error message, when it failed in-process. */
  error?: string;
}

/** A delivery handed to an {@link InvokeAgentTransport}. */
export interface InvokeAgentDelivery {
  /** The child delegation envelope for the worker. */
  envelope: DelegationEnvelope;
  /** The target worker agent class. */
  agentClass: string;
  /** The task payload for the worker. */
  task: Record<string, unknown>;
  /** The worker runner (used by in-process transports; ignored by async ones). */
  worker: WorkerRunner;
  /** The database handle. */
  db?: SmrtClassOptions['db'];
  /** DispatchBus for the correlated invoke/completion signals. */
  dispatchBus?: DispatchBus;
  /** Audit sink forwarded to {@link executeAsPrincipal}. */
  audit?: PrincipalAuditSink;
  /** Opt into Postgres RLS transaction wrapping. */
  postgresRls?: boolean;
  /** Logger for the default audit sink. */
  logger?: Logger;
}

/**
 * How a worker invocation is delivered: run it in-process now (inline), emit a
 * DispatchBus signal for a worker to process, or enqueue a job. Swapping the
 * transport never changes the principal-delegation or completion semantics.
 */
export interface InvokeAgentTransport {
  deliver(delivery: InvokeAgentDelivery): Promise<InvokeAgentResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((v): v is string => typeof v === 'string');
  return strings.length > 0 ? strings : undefined;
}

/**
 * Run a worker as the delegated principal and report its completion.
 *
 * The worker executes inside a single {@link executeAsPrincipal} context bound
 * to the envelope's principal (`runAsUserId` + `tenantId`) and acting **on
 * behalf of** the originating user — so its authority is the originating user's
 * live RBAC and every action audits back to that user. On completion (success
 * or failure) a correlated `agent.completed` dispatch is emitted **inside** the
 * principal's tenant context, so it is stamped with the right tenant and the
 * orchestrator can surface it back into the conversation.
 */
export async function executeDelegatedInvocation(options: {
  envelope: DelegationEnvelope;
  agentClass: string;
  task: Record<string, unknown>;
  worker: WorkerRunner;
  db?: SmrtClassOptions['db'];
  dispatchBus?: DispatchBus;
  audit?: PrincipalAuditSink;
  postgresRls?: boolean;
  logger?: Logger;
}): Promise<AgentCompletion> {
  const {
    envelope,
    agentClass,
    task,
    worker,
    db,
    dispatchBus,
    audit,
    postgresRls,
    logger,
  } = options;

  return executeAsPrincipal(
    {
      db,
      principal: {
        // The principal is the envelope's — the originating user, immutable.
        runAsUserId: envelope.runAsUserId,
        tenantId: envelope.tenantId,
        allowedTools: envelope.allowedTools,
      },
      onBehalfOfUserId: envelope.onBehalfOfUserId,
      agentClass,
      action: 'agent.invoke',
      auditMetadata: {
        correlationId: envelope.correlationId,
        depth: envelope.depth,
      },
      audit,
      postgresRls,
      logger,
    },
    async (run): Promise<AgentCompletion> => {
      let completion: AgentCompletion;
      try {
        const result = await worker({ run, envelope, agentClass, task, db });
        completion = {
          correlationId: envelope.correlationId,
          agentClass,
          onBehalfOfUserId: envelope.onBehalfOfUserId,
          ok: true,
          result,
        };
      } catch (error) {
        completion = {
          correlationId: envelope.correlationId,
          agentClass,
          onBehalfOfUserId: envelope.onBehalfOfUserId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      // Emit the correlated completion inside the tenant context so it is
      // stamped with the principal's tenant (readable by the orchestrator).
      if (dispatchBus) {
        await emitAgentCompletion(dispatchBus, completion);
      }
      return completion;
    },
  );
}

/**
 * Emit a correlated `agent.completed` dispatch for a worker's completion.
 */
export async function emitAgentCompletion(
  dispatchBus: DispatchBus,
  completion: AgentCompletion,
): Promise<void> {
  await dispatchBus.emit(
    AGENT_COMPLETED_SIGNAL,
    {
      agentClass: completion.agentClass,
      onBehalfOfUserId: completion.onBehalfOfUserId,
      ok: completion.ok,
      result: completion.result,
      error: completion.error,
    },
    {
      correlationId: completion.correlationId,
      source: completion.agentClass || 'agent',
    },
  );
}

/**
 * Read the correlated completions for an invocation, so the orchestrator can
 * surface a worker's result back into the conversation on a later turn (the
 * async transport). Returns `[]` when nothing has completed yet.
 */
export async function surfaceAgentCompletions(
  dispatchBus: DispatchBus,
  correlationId: string,
): Promise<AgentCompletion[]> {
  const dispatches = await dispatchBus.list({
    type: AGENT_COMPLETED_SIGNAL,
    correlationId,
  });
  return dispatches.map((dispatch) => {
    const payload = dispatch.payload as Record<string, unknown>;
    return {
      correlationId,
      agentClass:
        typeof payload.agentClass === 'string' ? payload.agentClass : '',
      onBehalfOfUserId:
        typeof payload.onBehalfOfUserId === 'string'
          ? payload.onBehalfOfUserId
          : '',
      ok: payload.ok === true,
      result: payload.result,
      error: typeof payload.error === 'string' ? payload.error : undefined,
    };
  });
}

/**
 * The default transport: run the worker in-process now and return its completion
 * as the tool observation, so the result is surfaced back into the conversation
 * in the same turn.
 */
export const inlineInvokeAgentTransport: InvokeAgentTransport = {
  async deliver(delivery): Promise<InvokeAgentResult> {
    const completion = await executeDelegatedInvocation({
      envelope: delivery.envelope,
      agentClass: delivery.agentClass,
      task: delivery.task,
      worker: delivery.worker,
      db: delivery.db,
      dispatchBus: delivery.dispatchBus,
      audit: delivery.audit,
      postgresRls: delivery.postgresRls,
      logger: delivery.logger,
    });
    return {
      status: completion.ok ? 'completed' : 'failed',
      correlationId: completion.correlationId,
      agentClass: completion.agentClass,
      depth: delivery.envelope.depth,
      result: completion.result,
      error: completion.error,
    };
  },
};

/**
 * An async transport that emits a correlated `agent.invoke` DispatchBus signal
 * for a worker to process out of band ({@link processAgentInvocations}). The
 * tool returns `enqueued`; the worker's completion is surfaced later via
 * {@link surfaceAgentCompletions}. The worker runner is *not* used here — it is
 * reconstructed on the processing side.
 */
export function createDispatchInvokeTransport(
  dispatchBus: DispatchBus,
  options: { source?: string } = {},
): InvokeAgentTransport {
  return {
    async deliver(delivery): Promise<InvokeAgentResult> {
      await dispatchBus.emit(
        AGENT_INVOKE_SIGNAL,
        {
          envelope: delivery.envelope,
          agentClass: delivery.agentClass,
          task: delivery.task,
        },
        {
          correlationId: delivery.envelope.correlationId,
          source: options.source ?? 'agents.orchestrator',
        },
      );
      return {
        status: 'enqueued',
        correlationId: delivery.envelope.correlationId,
        agentClass: delivery.agentClass,
        depth: delivery.envelope.depth,
      };
    },
  };
}

/**
 * Process pending `agent.invoke` signals for a subscriber, running each worker
 * as its delegated principal and emitting the correlated completion. This is the
 * worker side of {@link createDispatchInvokeTransport}.
 *
 * The envelope arrives from a (persisted, thus untrusted) dispatch payload, so
 * its depth is re-asserted before the worker runs — a tampered envelope cannot
 * drive the chain past {@link MAX_DELEGATION_DEPTH}.
 *
 * @returns The number of invocations processed.
 */
export async function processAgentInvocations(options: {
  dispatchBus: DispatchBus;
  subscriber: string;
  worker: WorkerRunner;
  db?: SmrtClassOptions['db'];
  audit?: PrincipalAuditSink;
  postgresRls?: boolean;
  logger?: Logger;
  limit?: number;
}): Promise<number> {
  const { dispatchBus, subscriber, worker, db, audit, postgresRls, logger } =
    options;
  const log = logger ?? createLogger({ level: 'info' });
  await dispatchBus.subscribe({
    signalType: AGENT_INVOKE_SIGNAL,
    subscriber,
  });
  return dispatchBus.process(
    subscriber,
    async (payload) => {
      const record = isRecord(payload) ? payload : {};
      const envelope = record.envelope as DelegationEnvelope | undefined;
      const agentClass =
        typeof record.agentClass === 'string' ? record.agentClass : '';
      if (!envelope || !agentClass) {
        log.warn('agent.invoke dispatch missing envelope or agentClass', {
          agentClass,
        });
        return;
      }
      // Defense in depth: a persisted (tamperable) envelope cannot exceed the
      // depth ceiling.
      assertWithinDelegationDepth(envelope.depth);
      await executeDelegatedInvocation({
        envelope,
        agentClass,
        task: isRecord(record.task) ? record.task : {},
        worker,
        db,
        dispatchBus,
        audit,
        postgresRls,
        logger,
      });
    },
    { limit: options.limit },
  );
}

/**
 * Options for {@link createInvokeAgentTool}.
 */
export interface CreateInvokeAgentToolOptions {
  /**
   * The **current run's** delegation envelope — the orchestrator's own (depth
   * `0`) when building the tool for a conversation, or a worker's own envelope
   * when building it for a nested/further delegation. Its principal is the
   * ceiling every child inherits; the live run context is the source of truth
   * for the principal and overrides this copy.
   */
  parentEnvelope: DelegationEnvelope;
  /** The worker runner used by in-process transports. */
  worker: WorkerRunner;
  /** Database handle for the worker's operations. */
  db?: SmrtClassOptions['db'];
  /** DispatchBus for correlated invoke/completion signals. */
  dispatchBus?: DispatchBus;
  /** Delivery transport. Defaults to {@link inlineInvokeAgentTransport}. */
  transport?: InvokeAgentTransport;
  /** Audit sink forwarded to {@link executeAsPrincipal}. */
  audit?: PrincipalAuditSink;
  /** Opt into Postgres RLS transaction wrapping. */
  postgresRls?: boolean;
  /** Logger for the default audit sink. */
  logger?: Logger;
  /** Resolve a worker's tool ceiling from its class (e.g. its persona tools). */
  resolveWorkerAllowedTools?: (agentClass: string) => string[] | undefined;
  /** Depth ceiling override (mainly for tests). */
  maxDepth?: number;
  /** Override the tool description offered to the model. */
  description?: string;
}

/**
 * Build the standard **invoke-agent** tool.
 *
 * Offered through the conversational tool loop and gated by the persona's
 * `allowedTools` (the model may only call it when `agents.invoke` is
 * allow-listed). Its handler:
 *
 * 1. re-asserts the fail-closed allow-list ({@link PrincipalRun.assertToolAllowed});
 * 2. derives the child {@link DelegationEnvelope} with the principal taken
 *    **from the live run context** — never from the tool arguments — so a worker
 *    cannot widen the principal, and increments the bounded depth;
 * 3. delivers the invocation via the configured transport.
 *
 * The child inherits the orchestrator's principal verbatim and acts on behalf of
 * the same originating user, so the worker runs under the originating user's
 * permissions and audits back to them.
 */
export function createInvokeAgentTool(
  options: CreateInvokeAgentToolOptions,
): PrincipalTool {
  const transport = options.transport ?? inlineInvokeAgentTransport;
  return {
    slug: INVOKE_AGENT_TOOL_SLUG,
    aiTool: {
      type: 'function',
      function: {
        name: INVOKE_AGENT_FUNCTION_NAME,
        description:
          options.description ??
          'Delegate a task to a worker agent. The worker runs under YOUR ' +
            'principal (the originating user) — it cannot exceed your ' +
            'permissions — and returns its completion.',
        parameters: {
          type: 'object',
          required: ['agentClass'],
          properties: {
            agentClass: {
              type: 'string',
              description: 'The worker agent class to invoke.',
            },
            task: {
              type: 'object',
              description: 'The task payload handed to the worker.',
            },
            allowedTools: {
              type: 'array',
              items: { type: 'string' },
              description:
                "The worker's tool ceiling (fail-closed). Cannot widen your principal.",
            },
          },
        },
      },
    },
    async execute({ run, args }): Promise<InvokeAgentResult> {
      // Execution gate (defense-in-depth behind the offer gate): the persona
      // must allow-list agents.invoke.
      run.assertToolAllowed(INVOKE_AGENT_TOOL_SLUG);

      const agentClass =
        typeof args.agentClass === 'string' ? args.agentClass.trim() : '';
      if (!agentClass) {
        throw new Error("invoke-agent requires a non-empty 'agentClass'.");
      }
      const task = isRecord(args.task) ? args.task : {};

      // The principal is taken from the LIVE run context, never from the tool
      // arguments — this is what makes the principal immutable along the chain:
      // a worker calling invoke-agent cannot pass a broader `runAsUserId` /
      // `tenantId`, because they are not read from `args` at all.
      const parent: DelegationEnvelope = {
        ...options.parentEnvelope,
        runAsUserId: run.context.userId ?? options.parentEnvelope.runAsUserId,
        tenantId: run.context.tenantId ?? options.parentEnvelope.tenantId,
      };

      // The worker's own tool ceiling (its persona's tools, else the requested
      // list). Never inherits the orchestrator's tools implicitly.
      const requestedAllowedTools =
        options.resolveWorkerAllowedTools?.(agentClass) ??
        asStringArray(args.allowedTools);

      const childEnvelope = deriveDelegationEnvelope(parent, {
        allowedTools: requestedAllowedTools,
        maxDepth: options.maxDepth,
      });

      return transport.deliver({
        envelope: childEnvelope,
        agentClass,
        task,
        worker: options.worker,
        db: options.db,
        dispatchBus: options.dispatchBus,
        audit: options.audit,
        postgresRls: options.postgresRls,
        logger: options.logger,
      });
    },
  };
}
