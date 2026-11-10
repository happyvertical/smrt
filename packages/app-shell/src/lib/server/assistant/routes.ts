// `mountAssistantRoutes`: the assistant's HTTP surface. The route files under
// `src/routes/api/assistant/` are one-liners over the handlers built here.
//
//   GET  /api/assistant/status            -> AssistantStatus
//   GET  /api/assistant/threads           -> { threads: ThreadSummary[] }
//   GET  /api/assistant/threads/<id>      -> { thread, messages: ThreadMessage[] }
//   POST /api/assistant/turn  { message, threadId? }
//        -> text/event-stream, `event: turn`, data = TurnEvent (events.ts);
//           503 { type: 'unavailable', configured: false, code, error } when
//           the assistant cannot run (no key, AI off), never a crash.
//
// Owner session only (401/403), same-origin for the POST. The model is built
// per turn through the injected factory; closing the stream (the dock's Stop
// button, a closed tab) aborts the model call, the running tool and any hold.

import { join } from 'node:path';
import type { TurnEvent, TurnStop } from '../../assistant/events.ts';
import { tokenCredentials } from '../agent-cli/credentials.ts';
import { type AgentCliStatus, locateCli } from '../agent-cli/detect.ts';
import {
  agentCliDeps,
  asSettingsOwner,
  assistantSettings,
  cliStatus,
} from '../agent-cli/service.ts';
import type { AgentTool } from '../agent-cli/tools.ts';
import { dataRoot } from '../host.ts';
import {
  errorResponse,
  HttpError,
  ident,
  json,
  ownerOf,
  readJson,
} from '../http.ts';
import { runAs } from '../owner.ts';
import { type AgentEngineDeps, runAgentTurn } from './agent-turn.ts';
import { type AssistantConfigOptions, unavailableBody } from './config.ts';
import { cliTool, statusFor } from './engine.ts';
import type { holdForUser } from './hold.ts';
import { type AssistantModelFactory, createAiModelFactory } from './model.ts';
import {
  createThread,
  getThread,
  listThreads,
  viewMessages,
} from './threads.ts';
import { runTurn, type TurnLimits } from './turn.ts';

export const MAX_MESSAGE_CHARS = 8_000;

export interface AssistantRoutesOptions extends AssistantConfigOptions {
  /** Builds the turn's model. Default: the configured API-key client. */
  modelFactory?: AssistantModelFactory;
  limits?: Partial<TurnLimits>;
  /** Tests only. */
  hold?: typeof holdForUser;
  /** Which engine is chosen. Default: the owner's `assistant` preference. */
  engine?: () => Promise<'api' | 'claude-code' | 'codex'>;
  /** The local agent CLI engine's host wiring. Default: this app's runtime. */
  agent?: AgentEngineDeps;
  /** What the local CLIs report. Default: cached detection on this machine. */
  cliStatus?: (tool: AgentTool) => Promise<AgentCliStatus>;
}

/** Production wiring of the CLI engine: this app's runtime and data root. */
function productionAgent(): AgentEngineDeps {
  return {
    locate: (tool) => locateCli(tool, agentCliDeps()),
    credentials: tokenCredentials(async () => {
      const { runtime } = await import('../smrt.ts');
      return (await runtime.localRuntime()).mcpTokens;
    }),
    stateDir: async () => join(await dataRoot(), 'agent-cli'),
  };
}

type EventLike = Parameters<typeof ownerOf>[0] & {
  params: Record<string, string | undefined>;
};

export interface AssistantRoutes {
  status(event: EventLike): Promise<Response>;
  threads(event: EventLike): Promise<Response>;
  thread(event: EventLike): Promise<Response>;
  turn(event: EventLike): Promise<Response>;
}

function guard(handler: (event: EventLike) => Promise<Response>) {
  return async (event: EventLike): Promise<Response> => {
    try {
      return await handler(event);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function mountAssistantRoutes(
  options: AssistantRoutesOptions = {},
): AssistantRoutes {
  const factory = options.modelFactory ?? createAiModelFactory(options);
  const running = new Set<string>();
  const statusOfCli =
    options.cliStatus ?? ((tool: AgentTool) => cliStatus(tool));
  const agent = (): AgentEngineDeps => (options.agent ??= productionAgent());
  const engineOf = (owner: Parameters<typeof runAs>[0]) =>
    options.engine
      ? options.engine()
      : asSettingsOwner(
          owner,
          async () => (await assistantSettings().read()).engine,
        );

  return {
    status: guard(async (event) => {
      const owner = await ownerOf(event);
      return json(
        await statusFor(await engineOf(owner), owner, {
          config: options,
          cliStatus: statusOfCli,
        }),
      );
    }),

    threads: guard(async (event) => {
      const owner = await ownerOf(event);
      return json({ threads: await listThreads(owner.id) });
    }),

    thread: guard(async (event) => {
      const owner = await ownerOf(event);
      const thread = await getThread(owner.id, ident(event.params.id, 'id'));
      if (!thread) throw new HttpError(404, 'thread not found');
      return json({
        thread: {
          id: thread.id,
          title: thread.title,
          updatedAt: String(thread.updatedAt),
        },
        messages: await viewMessages(thread.id as string),
      });
    }),

    turn: guard(async (event) => {
      const owner = await ownerOf(event);
      const body = await readJson(event.request);
      const message =
        typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) throw new HttpError(400, '`message` must be some text');
      if (message.length > MAX_MESSAGE_CHARS)
        throw new HttpError(413, 'message too long');
      const threadId =
        body.threadId === undefined || body.threadId === null
          ? undefined
          : ident(String(body.threadId), 'threadId');

      if (running.has(owner.id))
        throw new HttpError(409, 'the assistant is already working on a turn');

      const engine = await engineOf(owner);
      const tool = cliTool(engine);
      let model: Awaited<ReturnType<AssistantModelFactory>> | undefined;
      if (tool) {
        const status = await statusFor(engine, owner, {
          config: options,
          cliStatus: statusOfCli,
        });
        if (!status.configured)
          return json(
            {
              type: 'unavailable',
              configured: false,
              code: status.code ?? 'agent_cli_missing',
              message: status.message ?? '',
              error: status.message ?? 'The assistant is not available.',
              action: status.action,
            },
            503,
          );
      } else {
        try {
          model = await factory({ principal: owner });
        } catch (error) {
          const body = unavailableBody(error);
          if (body) return json(body, 503);
          // Provider SDK messages can echo credentials: class name only.
          // biome-ignore lint/suspicious/noConsole: class only, never a message
          console.error(
            'assistant model setup failed:',
            error instanceof Error ? error.name : 'unknown',
          );
          throw new HttpError(503, 'The assistant could not start. Try again.');
        }
      }
      const thread = threadId
        ? await getThread(owner.id, threadId)
        : await createThread(owner.id, message);
      if (!thread) throw new HttpError(404, 'thread not found');

      running.add(owner.id);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let closed = false;
          const emit = (e: TurnEvent) => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(`event: turn\ndata: ${JSON.stringify(e)}\n\n`),
              );
            } catch {
              closed = true;
            }
          };
          emit({ type: 'thread', threadId: thread.id as string });
          try {
            await runAs(
              owner,
              (): Promise<TurnStop> =>
                tool
                  ? runAgentTurn({
                      principal: owner,
                      thread,
                      text: message,
                      tool,
                      mcpUrl: new URL('/mcp', event.url.origin).href,
                      signal: event.request.signal,
                      emit,
                      deps: agent(),
                    })
                  : runTurn({
                      principal: owner,
                      thread,
                      text: message,
                      model: model as NonNullable<typeof model>,
                      signal: event.request.signal,
                      emit,
                      limits: options.limits,
                      ...(options.hold ? { hold: options.hold } : {}),
                    }),
            );
          } catch (error) {
            // biome-ignore lint/suspicious/noConsole: class only, never a message
            console.error(
              'assistant turn failed:',
              error instanceof Error ? error.name : 'unknown',
            );
            emit({
              type: 'error',
              code: 'turn_failed',
              message: 'The assistant hit a problem. Try again.',
            });
            emit({ type: 'done', stop: 'error' });
          } finally {
            running.delete(owner.id);
            closed = true;
            try {
              controller.close();
            } catch {}
          }
        },
        cancel() {
          // The request signal aborts the turn; nothing else to release.
        },
      });
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
        },
      });
    }),
  };
}
