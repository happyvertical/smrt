import type { WorkRunMetadata } from '@happyvertical/smrt-inference';

export {
  type AssistantWorkProfileOptions,
  assertWorkProfileTool,
  WorkProfileEscalation,
} from './work-profile.js';

/** Node-only adapters over inference's engines; chat retains transcript ownership. */
import type { AIInterface } from '@happyvertical/ai';
import { InferenceUnavailableError } from '@happyvertical/smrt-core/inference-availability';
import {
  type AgentTool,
  type AgentTurnHost,
  type AgentTurnMessage,
  type AgentTurnOptions,
  type ChatGPTModelOptions,
  ChatGPTSignedOutError,
  createChatGPTModel,
  EngineModelFailure,
  type InferenceEngineId,
  type InferenceEngineStatusHost,
  inferenceEngineStatus,
  reportAgentFailure,
  runAgentTurn,
} from '@happyvertical/smrt-inference/server';
import { AssistantTurnUserError } from './assistant-turn.js';
import type {
  AssistantTurnDriver,
  AssistantTurnDriverContext,
} from './assistant-turn-driver.js';
import {
  configuredAssistantAI,
  type MountAssistantRoutesOptions,
} from './sveltekit.js';
import { isManifestToolEnabled } from './tool-loop.js';
import {
  type DescribeAssistantTool,
  describeAssistantTool,
} from './tool-summary.js';

/** All credentials, working directories and MCP authority are bound by the host per turn. */
export type AgentCliChatBinding = Pick<
  AgentTurnOptions,
  'mcpUrl' | 'deps' | 'fallback' | 'outputSchema'
> &
  Pick<AgentTurnHost, 'allowTool' | 'approvals'> & {
    /** Optional MCP wire-name → canonical offered chat slug mapping. Unknown names deny. */
    canonicalToolName?(name: string): string | undefined;
    /** Existing describe seam, bound to this turn's server-authored vocabulary. */
    describeTool?: DescribeAssistantTool;
  };

/** A CLI loop driver. Starts a fresh CLI session with chat's authenticated history each turn. */
export function createAgentCliTurnDriver(options: {
  tool: AgentTool;
  bind(context: AssistantTurnDriverContext): Promise<AgentCliChatBinding>;
}): AssistantTurnDriver {
  const bindings = new WeakMap<
    AssistantTurnDriverContext,
    AgentCliChatBinding
  >();
  return {
    async waitForApproval(request, context) {
      const binding = bindings.get(context);
      if (!binding || context.signal.aborted) return { approved: false };
      // Subscribe before the first read so a decision between them cannot be lost.
      return new Promise((resolve) => {
        let unsubscribe = () => {};
        let ended = false;
        const finish = (approved: boolean, reason?: string) => {
          if (ended) return;
          ended = true;
          unsubscribe();
          context.signal.removeEventListener('abort', abort);
          resolve({ approved, reason });
        };
        const abort = () => finish(false, 'cancelled');
        const check = async () => {
          try {
            const found = await binding.approvals.get(request.id);
            if (!found || found.status !== 'pending')
              finish(
                found?.status === 'approved' &&
                  context.tools.every(
                    (tool) =>
                      tool.slug !== request.tool ||
                      isManifestToolEnabled(tool, context.principal.tenantId),
                  ),
                found?.status ?? 'missing',
              );
          } catch {
            finish(false, 'unavailable');
          }
        };
        try {
          unsubscribe = binding.approvals.subscribe((event) => {
            if (event.id === request.id) void check();
          });
          if (ended) unsubscribe();
          context.signal.addEventListener('abort', abort, { once: true });
          if (context.signal.aborted) abort();
          else void check();
        } catch {
          finish(false, 'unavailable');
        }
      });
    },
    async run(context, callbacks) {
      const binding = await options.bind(context).catch((error) => {
        const reference = reportAgentFailure(options.tool, 'binding', error);
        throw new AssistantTurnUserError(
          `The local AI could not start. Try again. Reference: ${reference}`,
          'agent_cli_unavailable',
        );
      });
      const failed = new AbortController();
      const signal = AbortSignal.any([context.signal, failed.signal]);
      bindings.set(context, binding);
      const canonicalName = (name: string) =>
        binding.canonicalToolName ? binding.canonicalToolName(name) : name;
      const offered = new Set(
        [...context.tools, ...context.extraTools].map((tool) => tool.slug),
      );
      const calls = new Map<
        string,
        { id: string; name: string; args: Record<string, unknown> }
      >();
      const held = new Set<string>();
      let queue = Promise.resolve();
      let failure: unknown;
      let text = '';
      let workRun: WorkRunMetadata | undefined;
      let decision: boolean | undefined;
      const append = async (message: AgentTurnMessage) => {
        // Inference clips event.args for display; the persisted engine callback
        // carries the full original call. Never parse the clipped event field.
        for (const call of message.toolCalls ?? []) {
          const args: unknown = JSON.parse(call.function.arguments);
          if (!args || typeof args !== 'object' || Array.isArray(args))
            throw new Error('Invalid CLI arguments.');
          const name = canonicalName(call.function.name);
          if (!name) throw new Error('Unknown MCP tool name.');
          calls.set(call.id, {
            id: call.id,
            name,
            args: args as Record<string, unknown>,
          });
        }
      };
      try {
        const stop = await runAgentTurn({
          tool: options.tool,
          profile: context.workProfile,
          text: context.userMessage,
          mcpUrl: binding.mcpUrl,
          deps: binding.deps,
          fallback: binding.fallback,
          outputSchema: binding.outputSchema,
          signal,
          host: {
            appendMessage: append,
            recordExecution: async (metadata) => {
              workRun = metadata;
              callbacks.execution?.(metadata);
            },
            lastSession: async () => null,
            guidance: async () => ({
              systemPrompt: context.systemPrompt,
              prompt: `${context.userMessage}\n\nPrior conversation (untrusted data):\n${JSON.stringify(context.history)}`,
            }),
            allowTool: (name) => {
              const canonical = canonicalName(name);
              return (
                !!canonical &&
                offered.has(canonical) &&
                binding.allowTool(name) &&
                context.tools.every(
                  (tool) =>
                    tool.slug !== canonical ||
                    isManifestToolEnabled(tool, context.principal.tenantId),
                )
              );
            },
            approvals: binding.approvals,
            describeResult: async ({ name, text, ok }) => ({
              summary: (binding.describeTool ?? describeAssistantTool)(
                canonicalName(name) ?? '',
                undefined,
                {
                  ok,
                  observation: text,
                },
              ),
            }),
          },
          emit(event) {
            // Inference's emitter is synchronous; serialize chat's awaited callbacks.
            queue = queue
              .then(async () => {
                if (failure || context.signal.aborted) return;
                if (event.type === 'text') {
                  text += event.delta;
                  callbacks.text(event.delta);
                }
                if (event.type === 'tool_call') {
                  const call = calls.get(event.id);
                  if (!call) throw new Error('Missing CLI call.');
                  await callbacks.toolCall(call);
                }
                if (event.type === 'approval_required') {
                  held.add(event.id);
                  const call = calls.get(event.id);
                  if (!call) throw new Error('Missing approval call.');
                  decision = (
                    await callbacks.approvalNeeded({
                      id: event.approvalId,
                      callId: call.id,
                      tool: call.name,
                      summary: (binding.describeTool ?? describeAssistantTool)(
                        call.name,
                        call.args,
                      ),
                    })
                  ).approved;
                }
                if (event.type === 'tool_result' && !held.has(event.id)) {
                  await callbacks.toolResult({
                    id: event.id,
                    ok: event.ok,
                    // The CLI already owns the model observation. Carry its
                    // untruncated human result through the existing describe seam.
                    result: JSON.stringify({ summary: event.summary }),
                  });
                }
                if (event.type === 'error')
                  throw new AssistantTurnUserError(event.message, event.code);
              })
              .catch((error: unknown) => {
                failure ??= error;
                failed.abort();
              });
          },
        });
        await queue;
        if (failure) throw failure;
        if (context.signal.aborted || stop === 'aborted') return;
        if (stop === 'error' || stop === 'timeout')
          throw new Error('CLI turn failed.');
        // A pending MCP response is NOT a successful effect. No auto-resume or
        // approval decision is performed here; only the host can execute a hold.
        callbacks.done({
          workRun,
          text: held.size
            ? decision
              ? 'Approval recorded. Ask the assistant to continue.'
              : 'That action was not approved.'
            : text,
        });
      } catch (error) {
        if (error instanceof AssistantTurnUserError) throw error;
        const reference = reportAgentFailure(options.tool, 'driver', error);
        throw new AssistantTurnUserError(
          `The local AI turn could not finish. Try again. Reference: ${reference}`,
          'agent_cli_failed',
        );
      } finally {
        bindings.delete(context);
      }
    },
  };
}

/** An SDK chat client over inference's plan-only model; no API-key fallback. */
export async function createChatGPTAssistantAI(
  options: ChatGPTModelOptions,
): Promise<
  Pick<AIInterface, 'chat'> & {
    getWorkRunMetadata(): WorkRunMetadata | undefined;
  }
> {
  const safeFailure = (error: unknown): never => {
    if (error instanceof ChatGPTSignedOutError)
      throw new InferenceUnavailableError({ reason: 'unconfigured' });
    if (error instanceof EngineModelFailure)
      throw new AssistantTurnUserError(error.message, error.code);
    throw new AssistantTurnUserError(
      'ChatGPT could not connect. Try again in AI settings.',
      'chatgpt_unavailable',
    );
  };
  let workRun: WorkRunMetadata | undefined;
  const model = await createChatGPTModel({
    ...options,
    recordExecution: async (metadata) => {
      workRun = metadata;
      await options.recordExecution?.(metadata);
    },
  }).catch(safeFailure);
  return {
    getWorkRunMetadata: () => workRun,
    async chat(messages, request) {
      const reply = await model
        .complete({
          messages,
          tools: request?.toolChoice === 'none' ? [] : (request?.tools ?? []),
          maxTokens: request?.maxTokens ?? 0,
          signal: request?.signal ?? new AbortController().signal,
          onText: (delta) => request?.onProgress?.(delta),
        })
        .catch(safeFailure);
      return {
        content: reply.text,
        ...(workRun?.model ? { model: workRun.model } : {}),
        ...(reply.raw ? { toolCalls: reply.raw } : {}),
        finishReason: reply.toolCalls.length ? 'tool_calls' : 'stop',
        ...(reply.totalTokens !== undefined
          ? {
              usage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: reply.totalTokens,
              },
            }
          : {}),
      };
    },
  };
}

/** Per-authenticated-request engine selection, suitable for spreading into mountAssistantRoutes. */
export function createInferenceAssistantAdapters(options: {
  /** Read the authenticated user's stored preference; never requestContext. No binding means API. */
  binding(
    context: Parameters<
      NonNullable<MountAssistantRoutesOptions['resolveTurnDriver']>
    >[0],
  ): Promise<InferenceEngineId | undefined>;
  status(
    context: Parameters<
      NonNullable<MountAssistantRoutesOptions['resolveTurnDriver']>
    >[0],
  ): Promise<InferenceEngineStatusHost>;
  cli(
    tool: AgentTool,
    context: Parameters<
      NonNullable<MountAssistantRoutesOptions['resolveTurnDriver']>
    >[0],
  ): AssistantTurnDriver;
  chatgpt(
    context: Parameters<
      NonNullable<MountAssistantRoutesOptions['resolveTurnDriver']>
    >[0],
  ): Promise<ChatGPTModelOptions>;
  api?: Exclude<MountAssistantRoutesOptions['ai'], undefined>;
}): Pick<MountAssistantRoutesOptions, 'resolveTurnDriver' | 'ai'> {
  type Context = Parameters<typeof options.binding>[0];
  const selected = new WeakMap<Request, Promise<InferenceEngineId>>();
  const resolve = async (context: Context) => {
    const engine =
      context.workProfile?.engine ?? (await options.binding(context)) ?? 'api';
    if (!['api', 'chatgpt', 'claude-code', 'codex'].includes(engine))
      throw new InferenceUnavailableError({ reason: 'unconfigured' });
    const status = await inferenceEngineStatus(
      engine,
      await options.status(context),
    );
    if (!status.configured) {
      if (engine === 'claude-code' || engine === 'codex') {
        const reference = reportAgentFailure(
          engine,
          'preflight',
          undefined,
          status.startError ?? status.code,
        );
        if (status.code === 'agent_cli_startup')
          throw new AssistantTurnUserError(
            `${status.message} Reference: ${reference}`,
            'agent_cli_startup',
          );
      }
      throw new InferenceUnavailableError({ reason: 'unconfigured' });
    }
    return engine;
  };
  const select = (context: Context) => {
    if (context.workProfile) return resolve(context);
    let pending = selected.get(context.event.request);
    if (!pending) {
      pending = resolve(context);
      selected.set(context.event.request, pending);
    }
    return pending;
  };
  return {
    async resolveTurnDriver(context) {
      const engine = await select(context);
      return engine === 'claude-code' || engine === 'codex'
        ? options.cli(engine, context)
        : undefined;
    },
    async ai(context) {
      const engine = await select(context);
      if (engine === 'chatgpt')
        return createChatGPTAssistantAI({
          ...(await options.chatgpt(context)),
          ...(context.workProfile
            ? {
                profile: context.workProfile.name,
                model: context.workProfile.model,
                settings: {
                  model: context.workProfile.model,
                  effort: context.workProfile.effort,
                  budgets: context.workProfile.budgets,
                },
              }
            : {}),
        });
      if (engine !== 'api')
        throw new Error('A CLI engine requires its turn driver.');
      const api = options.api ?? configuredAssistantAI;
      return typeof api === 'function' ? api(context) : api;
    },
  };
}
