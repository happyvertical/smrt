// Browser-side calls to the shell's JSON routes. Every route answers
// `{ error, code? }` on failure; that message is shown as is.
import { methodToolName } from './fields.ts';
import type { PendingApproval } from './types.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function isPendingApproval(v: unknown): v is PendingApproval {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { status?: unknown }).status === 'pending_approval'
  );
}

type Fetch = typeof fetch;

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; fetch?: Fetch } = {},
): Promise<{ status: number; data: T }> {
  const doFetch = init.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(path, {
      method: init.method ?? 'GET',
      headers:
        init.body !== undefined ? { 'content-type': 'application/json' } : {},
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Could not reach the app. Check your connection.');
  }
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const body = (data ?? {}) as { error?: unknown; code?: unknown };
    throw new ApiError(
      response.status,
      typeof body.error === 'string' && body.error
        ? body.error
        : `Request failed (${response.status})`,
      typeof body.code === 'string' ? body.code : undefined,
    );
  }
  return { status: response.status, data: data as T };
}

const rec = (model: string) =>
  `/api/shell/records/${encodeURIComponent(model)}`;

export const records = {
  create: (model: string, data: Record<string, unknown>) =>
    api<Record<string, unknown>>(rec(model), { method: 'POST', body: data }),
  update: (model: string, id: string, data: Record<string, unknown>) =>
    api<Record<string, unknown>>(`${rec(model)}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: data,
    }),
  /** 202 with a PendingApproval: nothing is deleted until the owner approves. */
  remove: (model: string, id: string) =>
    api<PendingApproval | { deleted: string }>(
      `${rec(model)}/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
};

export const decideApproval = (id: string, approve: boolean) =>
  api<{ id: string; status: string; result?: unknown; error?: string }>(
    `/api/shell/approvals/${encodeURIComponent(id)}`,
    { method: 'POST', body: { approve } },
  );

export const undoLast = () =>
  api<{ version: number; summary: string }>('/api/shell/undo', {
    method: 'POST',
  });

export interface MethodOutcome {
  isError: boolean;
  text: string;
  /** Parsed `{ result, applied }` when the tool answered in that shape. */
  result?: unknown;
  applied?: number;
}

function parseMcpBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  // Streamable HTTP may answer as one server-sent message.
  const data = trimmed
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');
  return JSON.parse(data);
}

/** Call a code method's generated tool through the shell's `/mcp` route. */
export async function runMethodTool(
  className: string,
  method: string,
  args: Record<string, unknown>,
  fetchImpl: Fetch = fetch,
): Promise<MethodOutcome> {
  let response: Response;
  try {
    response = await fetchImpl('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: methodToolName(className, method), arguments: args },
      }),
    });
  } catch {
    throw new ApiError(0, 'Could not reach the app. Check your connection.');
  }
  const raw = await response.text();
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = JSON.parse(raw) as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {}
    throw new ApiError(response.status, message);
  }
  let rpc: {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  try {
    rpc = parseMcpBody(raw) as typeof rpc;
  } catch {
    throw new ApiError(502, 'The app answered in an unexpected format.');
  }
  if (rpc.error) throw new ApiError(400, rpc.error.message ?? 'Call failed');
  const text = rpc.result?.content?.map((c) => c.text ?? '').join('\n') ?? '';
  const outcome: MethodOutcome = { isError: !!rpc.result?.isError, text };
  try {
    const parsed = JSON.parse(text) as { result?: unknown; applied?: unknown };
    if (parsed && typeof parsed === 'object' && 'result' in parsed) {
      outcome.result = parsed.result;
      if (typeof parsed.applied === 'number') outcome.applied = parsed.applied;
    }
  } catch {}
  return outcome;
}
