/**
 * ToolLoop — a bounded `tool_call → observe → respond` agentic loop over the
 * SMRT manifest operation surface (L3 of the learning-agents epic, #1891).
 *
 * The universe of tools is **closed**: every tool is a manifest operation of an
 * installed SMRT package — an object's CRUD or *public custom action*, each a
 * `(collection, action)` in the manifest-derived permission catalog
 * ({@link PermissionCatalogService}). The loop invokes them **in-process
 * ("side door")** — no HTTP/MCP round-trip — inside the persona's
 * session-permission context ({@link executeAsPrincipal}), so tenant isolation
 * and per-operation authority (Postgres RLS, or the catalog assert when RLS is
 * off) apply through any door.
 *
 * Two independent gates make the loop fail-closed:
 *
 *  1. **Offer gate** — the available tools are exactly the manifest operations
 *     filtered by the persona's `allowedTools`. A tool outside the allow-list is
 *     never offered to the model, and a hallucinated tool name is rejected
 *     without execution.
 *  2. **Execution gate** — every executed tool additionally re-asserts the
 *     fail-closed allow-list ({@link PrincipalRun.assertToolAllowed}) and the
 *     catalog permission for its `(collection, action)`
 *     ({@link PrincipalRun.assertOperation}), so even a bug in the offer gate
 *     cannot run an un-permitted operation.
 *
 * The loop is bounded by a max-steps ceiling: after `maxSteps` tool-executing
 * rounds it disables tools for one final completion, guaranteeing termination
 * with a text answer.
 *
 * @module
 */

import type {
  AIInterface,
  AIMessage,
  AIResponse,
  AITool,
  ChatOptions,
} from '@happyvertical/ai';
import {
  executeAsPrincipal,
  type PrincipalAuditSink,
  type PrincipalBinding,
  type PrincipalRun,
  PrincipalToolNotAllowedError,
} from '@happyvertical/smrt-agents';
import {
  ObjectRegistry,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  OperationPermissionError,
  PermissionCatalogService,
  type PermissionDefinition,
} from '@happyvertical/smrt-users';

/** Default ceiling on tool-executing rounds before the loop force-terminates. */
export const DEFAULT_MAX_STEPS = 8;

/**
 * A transcript message that may carry an OpenAI-style `tool_call_id` on a tool
 * observation. A structural superset of {@link AIMessage}, so the working
 * transcript stays assignable to `AIMessage[]` for `ai.chat()`.
 */
type LoopMessage = AIMessage & { tool_call_id?: string };

/**
 * A single manifest operation the loop can offer and execute. Its {@link slug}
 * is simultaneously the tool's stable name AND its permission-catalog slug — one
 * source of truth for both what the model may call and what the principal must
 * be permitted to do.
 */
export interface ManifestTool {
  /** Catalog slug (`collection.action`) — the tool name and the permission slug. */
  slug: string;
  /** Collection (permission resource), e.g. `articles`. */
  collection: string;
  /** Registry class name used to resolve the backing collection, e.g. `Article`. */
  className: string;
  /** Catalog action: `read` / `create` / `update` / `delete`, or a public custom method name. */
  action: string;
  /** Qualified class name, when known. */
  qualifiedName?: string;
  /** Human-readable description surfaced to the model. */
  description?: string;
}

/**
 * The record of one tool invocation attempt in a loop turn.
 */
export interface ToolInvocation {
  /** The tool name the model asked for. */
  slug: string;
  /** Parsed arguments (best-effort JSON parse of the model's raw arguments). */
  args: Record<string, unknown>;
  /** Whether the operation executed successfully. */
  ok: boolean;
  /** The JSON-serializable observation fed back to the model. */
  observation: unknown;
  /** True when the call was denied (not on the allow-list / not permitted). */
  rejected: boolean;
  /** Error summary when `ok` is false. */
  error?: string;
}

/** Why {@link runToolLoop} returned. */
export type ToolLoopStopReason = 'stop' | 'max_steps' | 'no_tools';

/** The outcome of a {@link runToolLoop} turn. */
export interface ToolLoopResult {
  /** The model's final assistant text. */
  content: string;
  /** Number of tool-executing rounds completed. */
  steps: number;
  /** Why the loop stopped. */
  stoppedReason: ToolLoopStopReason;
  /** Every tool invocation attempted this turn, in order. */
  invocations: ToolInvocation[];
  /** The full working transcript (input messages + assistant/tool turns). */
  messages: AIMessage[];
  /** Total tokens reported by the AI boundary, when available. */
  totalTokens: number;
}

/** Context handed to a custom {@link ToolLoopOptions.executeTool} implementation. */
export interface ToolExecutionContext {
  /** The principal run whose context bounds this execution. */
  run: PrincipalRun;
  /** The manifest operation to execute. */
  tool: ManifestTool;
  /** Parsed tool arguments. */
  args: Record<string, unknown>;
  /** The database handle to operate against (already the RLS-bound tx when on). */
  db?: SmrtClassOptions['db'];
}

/**
 * Options for {@link runToolLoop}.
 */
export interface ToolLoopOptions {
  /** The AI boundary (the only thing mocked in tests). */
  ai: AIInterface;
  /** The initial conversation messages (system / history / user). */
  messages: AIMessage[];
  /** The manifest operations available this turn (already allow-list-filtered). */
  tools: ManifestTool[];
  /** The persona principal every tool call runs as. */
  principal: PrincipalBinding;
  /** Database handle the side-door operations run against. */
  db?: SmrtClassOptions['db'];
  /** Max tool-executing rounds before force-termination. Default {@link DEFAULT_MAX_STEPS}. */
  maxSteps?: number;
  /** Model id passed to the AI boundary. */
  model?: string;
  /** Sampling temperature. */
  temperature?: number;
  /** Max tokens per completion. */
  maxTokens?: number;
  /** Tool-choice behaviour while tools are offered. Default `'auto'`. */
  toolChoice?: ChatOptions['toolChoice'];
  /**
   * Override the side-door executor. The default
   * ({@link invokeManifestTool}) enforces the allow-list + catalog gate and
   * dispatches through the ObjectRegistry. Tests inject a stub to exercise loop
   * mechanics without a backing object.
   */
  executeTool?: (ctx: ToolExecutionContext) => Promise<unknown>;
  /** Notified after each tool invocation (for streaming/telemetry). */
  onInvocation?: (invocation: ToolInvocation) => void | Promise<void>;
  /** The originating user the turn runs on behalf of (audited). */
  onBehalfOfUserId?: string | null;
  /** Canonical agent class, recorded in the audit entry. */
  agentClass?: string;
  /** Audit sink forwarded to {@link executeAsPrincipal}. */
  audit?: PrincipalAuditSink;
  /** Opt into Postgres RLS transaction wrapping. */
  postgresRls?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Best-effort parse of the model's raw tool-call arguments (a JSON string).
 * A non-object or malformed payload yields `{}` so a bad-argument call still
 * flows through the permission gate rather than throwing before it.
 */
function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Derive the catalog action for a permission definition — the slug segment(s)
 * after the `collection.` prefix. Catalog slugs are built as
 * `${collection}.${action}`, so this recovers `read` / `create` / a custom
 * method name unambiguously.
 */
function actionFromDefinition(def: PermissionDefinition): string | null {
  const collection = def.collection;
  if (!collection || !def.slug.startsWith(`${collection}.`)) {
    return null;
  }
  const action = def.slug.slice(collection.length + 1);
  return action.length > 0 ? action : null;
}

/**
 * Build the closed catalog of manifest operations available as tools.
 *
 * Reads the manifest-derived {@link PermissionCatalog} and keeps only the
 * entries that name a dispatchable operation (a `(collection, action)` with a
 * resolvable backing class). Pass `allowedTools` to narrow the catalog to a
 * persona's least-privilege allow-list — this is the **offer gate**: a slug not
 * in `allowedTools` is never returned, so it is neither offered to the model nor
 * executed. A missing, `null`, or empty `allowedTools` yields **no tools**
 * (fail-closed) — the same whitelist semantics as `AgentSession`/
 * `PrincipalBinding` (S5 #1392), so forgetting the allow-list can only tighten,
 * never widen, the offered surface. Pass `all: true` to deliberately enumerate
 * the full manifest operation surface (e.g. an admin tool picker) — that is the
 * one explicit escape hatch, never the default.
 */
export function buildManifestToolCatalog(
  options: SmrtClassOptions & {
    /** Least-privilege allow-list to narrow the catalog by (fail-closed). */
    allowedTools?: string[] | null;
    /** Explicitly enumerate the ENTIRE manifest operation surface (no narrowing). */
    all?: boolean;
    /** Supply a pre-built catalog (skips the manifest walk). */
    catalog?: PermissionDefinition[];
  } = {},
): ManifestTool[] {
  const definitions =
    options.catalog ??
    PermissionCatalogService.create(options).getCatalog().permissions;

  // Fail-closed: an absent / `null` / empty allow-list permits NOTHING. Only an
  // explicit `all: true` disables the narrowing and returns the full surface, so
  // a caller that forgets `allowedTools` gets zero tools rather than every one.
  const filter =
    options.all === true ? null : new Set(options.allowedTools ?? []);

  const tools: ManifestTool[] = [];
  for (const def of definitions) {
    if (!def.className || !def.collection) {
      continue;
    }
    if (filter && !filter.has(def.slug)) {
      continue;
    }
    const action = actionFromDefinition(def);
    if (!action) {
      continue;
    }
    tools.push({
      slug: def.slug,
      collection: def.collection,
      className: def.className,
      action,
      qualifiedName: def.qualifiedName,
      description: def.description,
    });
  }
  return tools;
}

/**
 * JSON-schema parameters for a manifest operation, keyed off its action. Create
 * / update schemas are enriched with the object's declared field names (tool arg
 * schemas come from field metadata) when the registry can supply them.
 */
function toolParameters(tool: ManifestTool): Record<string, unknown> {
  const fieldProps = (): Record<string, unknown> => {
    const props: Record<string, unknown> = {};
    try {
      for (const [name] of ObjectRegistry.getFields(tool.className)) {
        if (typeof name === 'string') {
          props[name] = { type: 'string' };
        }
      }
    } catch {
      // No field metadata available — fall back to a free-form object.
    }
    return props;
  };

  switch (tool.action) {
    case 'read':
      return {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Fetch one row by id (omit to list).',
          },
          where: {
            type: 'object',
            description: 'Equality filters for a list.',
          },
          limit: { type: 'number' },
          offset: { type: 'number' },
        },
      };
    case 'create':
      return { type: 'object', properties: fieldProps() };
    case 'update':
      return {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' }, ...fieldProps() },
      };
    case 'delete':
      return {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      };
    default:
      return {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Target row id for the action.' },
        },
      };
  }
}

/**
 * A provider-safe function name for a catalog slug.
 *
 * Catalog slugs are `collection.action` and routinely contain a `.`, but many
 * providers (OpenAI) restrict function names to `[A-Za-z0-9_-]{1,64}`. This maps
 * the slug into that charset (dots → `-`) for the wire; {@link runToolLoop} maps
 * the returned name back to the tool, and `tool.slug` remains the internal
 * permission id. Distinct slugs stay distinct (the only substituted char is the
 * single `.` separator).
 */
export function toolFunctionName(slug: string): string {
  return slug.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

/**
 * Project a manifest operation into an AI function-tool definition. The function
 * name is the provider-safe rendering of the catalog slug
 * ({@link toolFunctionName}), so the model can only ever name a real operation.
 */
export function manifestToolToAITool(tool: ManifestTool): AITool {
  return {
    type: 'function',
    function: {
      name: toolFunctionName(tool.slug),
      description:
        tool.description ??
        `Manifest operation '${tool.action}' on '${tool.collection}'.`,
      parameters: toolParameters(tool),
    },
  };
}

interface OperableItem {
  toJSON: () => Record<string, unknown>;
  save: () => Promise<unknown>;
  delete: () => Promise<unknown>;
}

function itemToObservation(item: unknown): unknown {
  const candidate = item as { toJSON?: () => unknown } | null;
  return typeof candidate?.toJSON === 'function' ? candidate.toJSON() : item;
}

/**
 * Execute a manifest operation in-process ("side door") under the principal.
 *
 * Enforces both authority dimensions before touching data: the fail-closed tool
 * allow-list ({@link PrincipalRun.assertToolAllowed}) and the catalog permission
 * for the `(collection, action)` ({@link PrincipalRun.assertOperation}) — the
 * door-agnostic teeth that hold on RLS-off adapters and are a redundant second
 * gate under Postgres RLS. Data operations run against the principal context's
 * database (the RLS-bound transaction when RLS is on), so tenant + per-operation
 * enforcement apply exactly as they would through REST or MCP.
 */
export async function invokeManifestTool(
  run: PrincipalRun,
  tool: ManifestTool,
  args: Record<string, unknown>,
  options: { db?: SmrtClassOptions['db'] } = {},
): Promise<unknown> {
  // Gate 1: fail-closed allow-list (defense-in-depth behind the offer gate).
  run.assertToolAllowed(tool.slug);
  // Gate 2: door-agnostic catalog authority (the RLS-off teeth; redundant under RLS).
  await run.assertOperation(tool.collection, tool.action);

  // Operate against the principal context's database so RLS (when on) and tenant
  // auto-filtering bound the query; fall back to the supplied handle otherwise.
  const db = (run.context.database ?? options.db) as SmrtClassOptions['db'];
  const collection = await ObjectRegistry.getCollection(
    tool.className,
    db ? { db } : {},
  );

  switch (tool.action) {
    case 'read': {
      const id = typeof args.id === 'string' ? args.id : undefined;
      if (id) {
        const item = await collection.get(id);
        return item ? itemToObservation(item) : { found: false };
      }
      const items = await collection.list({
        where: asRecord(args.where),
        limit: typeof args.limit === 'number' ? args.limit : 50,
        offset: typeof args.offset === 'number' ? args.offset : 0,
      });
      return items.map(itemToObservation);
    }
    case 'create': {
      const item = (await collection.create(args)) as unknown as OperableItem;
      await item.save();
      return itemToObservation(item);
    }
    case 'update': {
      const { id, ...rest } = args;
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`'${tool.slug}' requires an 'id' to update.`);
      }
      const item = (await collection.get(id)) as unknown as OperableItem | null;
      if (!item) {
        return { found: false };
      }
      Object.assign(item, rest);
      await item.save();
      return itemToObservation(item);
    }
    case 'delete': {
      const id = typeof args.id === 'string' ? args.id : undefined;
      if (!id) {
        throw new Error(`'${tool.slug}' requires an 'id' to delete.`);
      }
      const item = (await collection.get(id)) as unknown as OperableItem | null;
      if (!item) {
        return { found: false };
      }
      await item.delete();
      return { success: true, id };
    }
    default: {
      // Public custom action: invoke the named method on the row.
      const { id, ...rest } = args;
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`'${tool.slug}' requires an 'id' for a custom action.`);
      }
      const item = await collection.get(id);
      if (!item) {
        return { found: false };
      }
      const method = (item as unknown as Record<string, unknown>)[tool.action];
      if (typeof method !== 'function') {
        throw new Error(
          `Method '${tool.action}' not found on '${tool.className}'.`,
        );
      }
      const result = await (
        method as (input: Record<string, unknown>) => Promise<unknown>
      ).call(item, rest);
      return result === undefined
        ? { success: true }
        : itemToObservation(result);
    }
  }
}

/**
 * Run a bounded `tool_call → observe → respond` loop over the manifest operation
 * surface, as the persona's bound principal.
 *
 * The whole turn runs inside a single {@link executeAsPrincipal} context, so
 * every tool call shares one published permission snapshot (matching what a
 * Postgres RLS session enforces) and the turn audits once as on-behalf-of the
 * originating user.
 *
 * @param options - The AI boundary, seed messages, allow-list-filtered tools,
 *   principal, and ceiling.
 * @returns The final assistant text plus the invocation log and transcript.
 */
export async function runToolLoop(
  options: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const {
    ai,
    messages,
    tools,
    principal,
    db,
    maxSteps = DEFAULT_MAX_STEPS,
    model,
    temperature,
    maxTokens,
    toolChoice = 'auto',
    executeTool,
    onInvocation,
    onBehalfOfUserId,
    agentClass,
    audit,
    postgresRls,
  } = options;

  const aiTools = tools.map(manifestToolToAITool);
  // Resolve the tool by EITHER the internal slug (a mock/pass-through provider)
  // OR the provider-safe function name the model actually receives, so the offer
  // gate holds regardless of how the provider renders the name.
  const offered = new Map<string, ManifestTool>();
  for (const tool of tools) {
    offered.set(tool.slug, tool);
    offered.set(toolFunctionName(tool.slug), tool);
  }

  return executeAsPrincipal(
    {
      db,
      principal,
      onBehalfOfUserId,
      agentClass,
      action: 'chat.tool_loop',
      postgresRls,
      audit,
    },
    async (run): Promise<ToolLoopResult> => {
      // `LoopMessage` carries `tool_call_id` on tool observations (OpenAI's tool
      // message shape needs it to correlate an observation to its call); it is a
      // structural superset of `AIMessage`, so the transcript stays chat-compatible.
      const working: LoopMessage[] = [...messages];
      const invocations: ToolInvocation[] = [];
      let executedRounds = 0;
      let totalTokens = 0;
      let response: AIResponse;

      for (;;) {
        const offerTools = aiTools.length > 0 && executedRounds < maxSteps;
        response = await ai.chat(working, {
          model,
          temperature,
          maxTokens,
          tools: offerTools ? aiTools : undefined,
          toolChoice: offerTools ? toolChoice : 'none',
        });
        totalTokens += response.usage?.totalTokens ?? 0;

        const toolCalls = offerTools ? (response.toolCalls ?? []) : [];
        if (toolCalls.length === 0) {
          return {
            content: response.content ?? '',
            steps: executedRounds,
            stoppedReason:
              aiTools.length === 0
                ? 'no_tools'
                : offerTools
                  ? 'stop'
                  : 'max_steps',
            invocations,
            messages: working,
            totalTokens,
          };
        }

        // Record the assistant's tool-call turn before appending observations.
        working.push({
          role: 'assistant',
          content: response.content ?? '',
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          const requestedName = call.function.name;
          const args = parseToolArguments(call.function.arguments);
          const tool = offered.get(requestedName);
          // Record the canonical slug (the permission id) for a resolved tool;
          // for a rejected/hallucinated call, echo whatever the model named.
          const slug = tool?.slug ?? requestedName;

          let invocation: ToolInvocation;
          if (!tool) {
            // Offer gate: a tool the persona was not offered (not on the
            // allow-list, or hallucinated) is rejected without execution.
            invocation = {
              slug,
              args,
              ok: false,
              rejected: true,
              observation: {
                error: `Tool '${slug}' is not permitted for this persona.`,
              },
              error: 'not_permitted',
            };
          } else {
            try {
              const observation = await (executeTool
                ? executeTool({ run, tool, args, db })
                : invokeManifestTool(run, tool, args, { db }));
              invocation = {
                slug,
                args,
                ok: true,
                rejected: false,
                observation,
              };
            } catch (error) {
              const rejected =
                error instanceof PrincipalToolNotAllowedError ||
                error instanceof OperationPermissionError;
              invocation = {
                slug,
                args,
                ok: false,
                rejected,
                observation: {
                  error: error instanceof Error ? error.message : String(error),
                },
                error: rejected ? 'not_permitted' : 'execution_error',
              };
            }
          }

          invocations.push(invocation);
          await onInvocation?.(invocation);
          working.push({
            role: 'tool',
            name: requestedName,
            // Correlate the observation to the exact call the model made — many
            // providers (OpenAI) require `tool_call_id` on a tool message and
            // mis-associate observations without it when several calls occur.
            tool_call_id: call.id,
            content: JSON.stringify(invocation.observation),
          });
        }

        executedRounds += 1;
      }
    },
  );
}
