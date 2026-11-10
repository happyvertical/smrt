// Browser calls for the dock. The turn is a streamed POST; Stop aborts the
// fetch, which the server sees as a disconnect and ends the turn.

import { targetPath } from '../ui/target.ts';
import type { ApprovalView } from '../ui/types.ts';
import type {
  AssistantStatus,
  ThreadMessage,
  ThreadSummary,
  TurnEvent,
} from './events.ts';
import { SseParser } from './stream.ts';

type Fetch = typeof fetch;

export class UnavailableError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly action?: { label: string; href: string },
  ) {
    super(message);
  }
}

export class AssistantRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, doFetch: Fetch): Promise<T> {
  let response: Response;
  try {
    response = await doFetch(targetPath(path, 'live'));
  } catch {
    throw new AssistantRequestError(0, 'Could not reach the app.');
  }
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok)
    throw new AssistantRequestError(
      response.status,
      body?.error ?? `Request failed (${response.status})`,
    );
  return body as T;
}

export const fetchStatus = (doFetch: Fetch = fetch) =>
  getJson<AssistantStatus>('/api/assistant/status', doFetch);

export async function fetchThreads(doFetch: Fetch = fetch) {
  return (
    await getJson<{ threads: ThreadSummary[] }>(
      '/api/assistant/threads',
      doFetch,
    )
  ).threads;
}

export const fetchThread = (id: string, doFetch: Fetch = fetch) =>
  getJson<{ thread: ThreadSummary; messages: ThreadMessage[] }>(
    `/api/assistant/threads/${encodeURIComponent(id)}`,
    doFetch,
  );

export async function fetchPendingApprovals(doFetch: Fetch = fetch) {
  const body = await getJson<{ approvals: ApprovalView[] }>(
    '/api/shell/approvals?status=pending',
    doFetch,
  );
  return body.approvals;
}

/** Approve or deny a card through the existing approvals route. */
export async function answerApproval(
  id: string,
  approve: boolean,
  doFetch: Fetch = fetch,
): Promise<{ status: 'approved' | 'denied' | 'failed'; error?: string }> {
  let response: Response;
  try {
    response = await doFetch(
      targetPath(`/api/shell/approvals/${encodeURIComponent(id)}`, 'live'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approve }),
      },
    );
  } catch {
    throw new AssistantRequestError(0, 'Could not reach the app.');
  }
  const body = (await response.json().catch(() => null)) as {
    status?: 'approved' | 'denied' | 'failed';
    error?: string;
  } | null;
  if (!response.ok || !body?.status)
    throw new AssistantRequestError(
      response.status,
      body?.error ?? `Request failed (${response.status})`,
    );
  return { status: body.status, ...(body.error ? { error: body.error } : {}) };
}

/**
 * Run one turn, calling `onEvent` for each streamed event. Resolves when the
 * stream ends (or `signal` aborts). Throws {@link UnavailableError} for the
 * typed 503 and {@link AssistantRequestError} for other failures.
 */
export async function streamTurn(
  input: { message: string; threadId: string | null; signal: AbortSignal },
  onEvent: (event: TurnEvent) => void,
  doFetch: Fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await doFetch(targetPath('/api/assistant/turn', 'live'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: input.message,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      }),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) return;
    throw new AssistantRequestError(0, 'Could not reach the app.');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      type?: string;
      code?: string;
      error?: string;
      action?: { label: string; href: string };
    } | null;
    if (response.status === 503 && body?.type === 'unavailable')
      throw new UnavailableError(
        body.error ?? 'The assistant is not available.',
        body.code ?? 'unavailable',
        body.action,
      );
    throw new AssistantRequestError(
      response.status,
      body?.error ?? `Request failed (${response.status})`,
    );
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true })))
        onEvent(event);
    }
  } catch {
    if (!input.signal.aborted)
      throw new AssistantRequestError(0, 'The connection dropped.');
  }
}
