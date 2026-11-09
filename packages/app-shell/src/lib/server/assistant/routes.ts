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

import type { TurnEvent } from '../../assistant/events.ts';
import {
  errorResponse,
  HttpError,
  ident,
  json,
  ownerOf,
  readJson,
} from '../http.ts';
import { runAs } from '../owner.ts';
import {
  type AssistantConfigOptions,
  assistantStatus,
  unavailableBody,
} from './config.ts';
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

  return {
    status: guard(async (event) => {
      const owner = await ownerOf(event);
      return json(await assistantStatus(owner, options));
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

      let model: Awaited<ReturnType<AssistantModelFactory>>;
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
            await runAs(owner, () =>
              runTurn({
                principal: owner,
                thread,
                text: message,
                model,
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
