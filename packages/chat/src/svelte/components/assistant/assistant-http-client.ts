/**
 * Browser half of the AssistantDock's mounted routes (#3368).
 *
 * `createAssistantHttpTransport` is `createSmrtAssistantTransport` pointed at
 * `mountAssistantRoutes` (`@happyvertical/smrt-chat/sveltekit`): reads use its
 * member-scoped `readEndpoint` unchanged, and the writes it leaves to the host
 * (`writeEndpoint`) are filled in here. `createAssistantHttpActionClient` is
 * the HTTP `AssistantActionClient` for the same routes' `actions/*`.
 *
 * Browser-safe: no server imports. Authentication is the host's session
 * cookie (same-origin `fetch`), or headers the host supplies.
 */
import type {
  DataSurfaceActionRequest,
  DataSurfaceActionResult,
  DataSurfaceRegistry,
} from '@happyvertical/smrt-ui/data-surface';
import {
  type AssistantAttachmentRef,
  type AssistantMessage,
  type AssistantMessageWire,
  type AssistantResumeTurnInput,
  type AssistantSendMessageInput,
  type AssistantSendMessageResult,
  type AssistantTransport,
  type AssistantTransportEvent,
  createSmrtAssistantTransport,
  type ModelOption,
  normalizeAssistantMessage,
  normalizeAssistantThreadSummary,
  readAssistantTurnResult,
} from './assistant-transport.js';
import type { AssistantActionClient } from './create-assistant-dock-controller.svelte.js';

/** Options shared by the HTTP transport and action client. */
export interface AssistantHttpOptions {
  /** Where `mountAssistantRoutes` is mounted, e.g. `/api/assistant`. */
  endpoint: string;
  fetchImpl?: typeof fetch;
  /** Extra request headers (e.g. a bearer token for a non-cookie host). */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Default `same-origin`, so the session cookie is sent. */
  credentials?: RequestCredentials;
}

/** Options for {@link createAssistantHttpTransport}. */
export interface AssistantHttpTransportOptions extends AssistantHttpOptions {
  /** When set, the dock renders `ModelPicker`; the server checks the choice. */
  models?: ModelOption[];
}

/** A non-2xx answer from the assistant routes. `message` is user-safe. */
export class AssistantHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'AssistantHttpError';
  }
}

function trimEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

function makeFetch(options: AssistantHttpOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const credentials = options.credentials ?? 'same-origin';
  return (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    // `createSmrtAssistantTransport` always sends a bearer header; with no
    // token it is empty noise, so drop it and rely on the session cookie.
    if (/^Bearer\s*$/i.test(headers.get('authorization') ?? '')) {
      headers.delete('authorization');
    }
    const extra =
      typeof options.headers === 'function'
        ? options.headers()
        : (options.headers ?? {});
    for (const [name, value] of Object.entries(extra)) {
      headers.set(name, value);
    }
    return fetchImpl(url, { ...init, headers, credentials });
  };
}

async function failure(response: Response): Promise<AssistantHttpError> {
  let message = `The assistant request failed (${response.status}).`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === 'string' && body.error) message = body.error;
    if (typeof body.code === 'string') code = body.code;
  } catch {
    // Not JSON: keep the generic message.
  }
  return new AssistantHttpError(message, response.status, code);
}

function isJson(response: Response): boolean {
  return /^application\/json\b/i.test(
    response.headers.get('content-type') ?? '',
  );
}

/** Turns a send/resume response (SSE turn, or the JSON duplicate answer)
 * into the dock's result. */
async function readTurn(
  response: Response,
  onEvent: ((event: AssistantTransportEvent) => void) | undefined,
): Promise<AssistantSendMessageResult> {
  if (!response.ok) throw await failure(response);
  if (isJson(response)) {
    const body = (await response.json()) as {
      inProgress?: boolean;
      userMessage?: AssistantMessageWire;
      assistantMessage?: AssistantMessageWire;
      messages?: AssistantMessageWire[];
    };
    return {
      inProgress: body.inProgress === true,
      ...(body.userMessage
        ? { userMessage: normalizeAssistantMessage(body.userMessage) }
        : {}),
      ...(body.assistantMessage
        ? { assistantMessage: normalizeAssistantMessage(body.assistantMessage) }
        : {}),
      messages: (body.messages ?? []).map(normalizeAssistantMessage),
    };
  }
  const result = await readAssistantTurnResult<AssistantMessageWire>(response, {
    mapMessage: normalizeAssistantMessage,
    onEvent,
  });
  const userMessage = result.messages?.find(
    (message: AssistantMessage) => message.role === 'user',
  );
  return userMessage ? { ...result, userMessage } : result;
}

/**
 * An {@link AssistantTransport} for routes served by `mountAssistantRoutes`.
 * Reads go through `createSmrtAssistantTransport`'s `readEndpoint`; writes,
 * streamed turns, resumes and uploads through the same endpoint.
 */
export function createAssistantHttpTransport(
  options: AssistantHttpTransportOptions,
): AssistantTransport {
  const base = trimEndpoint(options.endpoint);
  const request = makeFetch(options);
  const postJson = (path: string, body: unknown, signal?: AbortSignal) =>
    request(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  const threadPath = (threadId: string, leaf: string) =>
    `/threads/${encodeURIComponent(threadId)}/${leaf}`;

  return createSmrtAssistantTransport({
    readEndpoint: base,
    token: '',
    fetchImpl: ((url: string | URL | Request, init?: RequestInit) =>
      request(String(url), init)) as typeof fetch,
    ...(options.models ? { models: options.models } : {}),
    writeEndpoint: {
      async createThread(title: string) {
        const response = await postJson('/threads', { title });
        if (!response.ok) throw await failure(response);
        const body = (await response.json()) as {
          thread: Parameters<typeof normalizeAssistantThreadSummary>[0];
        };
        return normalizeAssistantThreadSummary(body.thread);
      },
      async sendMessage(input: AssistantSendMessageInput) {
        const response = await postJson(
          threadPath(input.threadId, 'messages'),
          {
            content: input.content,
            clientRequestId: input.clientRequestId,
            ...(input.attachments?.length
              ? { attachments: input.attachments }
              : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.clientTools?.length
              ? { clientTools: input.clientTools }
              : {}),
          },
          input.signal,
        );
        return readTurn(response, input.onEvent);
      },
      async resumeTurn(input: AssistantResumeTurnInput) {
        const response = await postJson(
          threadPath(input.threadId, 'resume'),
          {
            clientRequestId: input.clientRequestId,
            continuationId: input.continuationId,
            results: input.results,
            ...(input.model ? { model: input.model } : {}),
            ...(input.clientTools?.length
              ? { clientTools: input.clientTools }
              : {}),
          },
          input.signal,
        );
        return readTurn(response, input.onEvent);
      },
      async uploadAttachment(file: File): Promise<AssistantAttachmentRef> {
        const form = new FormData();
        form.set('file', file, file.name);
        const response = await request(`${base}/attachments`, {
          method: 'POST',
          body: form,
        });
        if (!response.ok) throw await failure(response);
        const body = (await response.json()) as {
          attachment: AssistantAttachmentRef;
        };
        return body.attachment;
      },
    },
  });
}

/** Options for {@link createAssistantHttpActionClient}. */
export interface AssistantHttpActionClientOptions extends AssistantHttpOptions {
  /**
   * The registry the dock reads surfaces from; each call sends the surface's
   * current revision as `expectedRevision`, so a page that changed since the
   * preview is refused as `stale_revision` by the server.
   */
  registry?: Pick<DataSurfaceRegistry, 'inspect'>;
  /** Override for the revision; wins over `registry`. */
  expectedRevision?: (request: DataSurfaceActionRequest) => number | undefined;
}

/**
 * An HTTP {@link AssistantActionClient} for `mountAssistantRoutes`'
 * `actions/preview` and `actions/apply` (#2990 outcome rules):
 * - 200 → the server's own result (refusals included);
 * - apply 4xx → a refusal `{ ok: false, reason }` (nothing ran);
 * - apply 5xx or a network failure → rejects, which the dock treats as an
 *   unknown outcome and retries with the same idempotency key;
 * - preview non-2xx → rejects.
 */
export function createAssistantHttpActionClient(
  options: AssistantHttpActionClientOptions,
): AssistantActionClient {
  const base = trimEndpoint(options.endpoint);
  const request = makeFetch(options);

  const revisionOf = (action: DataSurfaceActionRequest): number => {
    const revision =
      options.expectedRevision?.(action) ??
      options.registry?.inspect(action.identity)?.revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
      throw new Error(
        'AssistantDock: the surface is not mounted, so the action has no revision.',
      );
    }
    return revision as number;
  };

  const call = async (
    phase: 'preview' | 'apply',
    action: DataSurfaceActionRequest,
    idempotencyKey?: string,
  ): Promise<DataSurfaceActionResult> => {
    const body = {
      ...action,
      phase,
      expectedRevision: revisionOf(action),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    const response = await request(`${base}/actions/${phase}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      const payload = (await response.json()) as {
        result?: DataSurfaceActionResult;
      };
      if (!payload.result) {
        throw new Error('AssistantDock: the action route sent no result.');
      }
      return payload.result;
    }
    const error = await failure(response);
    if (phase === 'apply' && response.status >= 400 && response.status < 500) {
      return {
        version: 1,
        requestId: action.requestId,
        identity: action.identity,
        actionId: action.actionId,
        phase: 'apply',
        ok: false,
        reason:
          response.status === 401 || response.status === 403
            ? 'denied'
            : (error.code ?? 'invalid_request'),
      };
    }
    throw error;
  };

  return {
    preview: (action) => call('preview', action),
    apply: (action, idempotencyKey) => call('apply', action, idempotencyKey),
  };
}
