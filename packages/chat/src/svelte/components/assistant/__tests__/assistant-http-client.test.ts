/**
 * HTTP action client and transport error mapping (#3368). The round trip
 * against the real `mountAssistantRoutes` handlers lives in
 * `src/sveltekit.test.ts`; this file pins the #2990 outcome rules.
 */
import type { DataSurfaceActionRequest } from '@happyvertical/smrt-ui/data-surface';
import { describe, expect, it, vi } from 'vitest';
import {
  AssistantHttpError,
  createAssistantHttpActionClient,
  createAssistantHttpTransport,
} from '../assistant-http-client.js';

const action: DataSurfaceActionRequest = {
  version: 1,
  requestId: 'r1',
  identity: { surfaceId: 'articles', kind: 'table' },
  actionId: 'archive',
  phase: 'preview',
  selection: { scope: 'explicit-ids', rowIds: ['a1'] },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function client(
  respond: (body: Record<string, unknown>) => Response | Promise<Response>,
) {
  const seen: Array<{
    url: string;
    body: Record<string, unknown>;
    init: RequestInit;
  }> = [];
  const fetchImpl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push({ url: String(url), body, init: init ?? {} });
      return respond(body);
    },
  ) as unknown as typeof fetch;
  const actions = createAssistantHttpActionClient({
    endpoint: '/api/assistant/',
    fetchImpl,
    registry: { inspect: () => ({ revision: 7 }) as never },
  });
  return { actions, seen, fetchImpl };
}

describe('createAssistantHttpActionClient', () => {
  it('sends the registry revision and the idempotency key, and returns the server result', async () => {
    const { actions, seen } = client((body) =>
      jsonResponse({
        result: {
          version: 1,
          requestId: body.requestId,
          identity: body.identity,
          actionId: body.actionId,
          phase: body.phase,
          ok: true,
        },
      }),
    );
    await expect(actions.preview(action)).resolves.toMatchObject({ ok: true });
    await expect(actions.apply(action, 'key-1')).resolves.toMatchObject({
      ok: true,
      phase: 'apply',
    });
    expect(seen[0].url).toBe('/api/assistant/actions/preview');
    expect(seen[0].body).toMatchObject({
      phase: 'preview',
      expectedRevision: 7,
    });
    expect(seen[0].body).not.toHaveProperty('idempotencyKey');
    expect(seen[1].url).toBe('/api/assistant/actions/apply');
    expect(seen[1].body).toMatchObject({
      phase: 'apply',
      expectedRevision: 7,
      idempotencyKey: 'key-1',
    });
    expect(seen[1].init.credentials).toBe('same-origin');
  });

  it('passes a server refusal through unchanged', async () => {
    const { actions } = client((body) =>
      jsonResponse({
        result: { ...body, ok: false, reason: 'stale_revision' },
      }),
    );
    await expect(actions.apply(action, 'k')).resolves.toMatchObject({
      ok: false,
      reason: 'stale_revision',
    });
  });

  it('maps an apply 4xx to a refusal and a 5xx or network failure to a rejection', async () => {
    const forbidden = client(() =>
      jsonResponse({ error: 'no', code: 'invalid_origin' }, 403),
    );
    await expect(forbidden.actions.apply(action, 'k')).resolves.toMatchObject({
      ok: false,
      reason: 'denied',
      requestId: 'r1',
      phase: 'apply',
    });
    const invalid = client(() =>
      jsonResponse({ error: 'bad', code: 'invalid_request' }, 400),
    );
    await expect(invalid.actions.apply(action, 'k')).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_request',
    });
    const broken = client(() =>
      jsonResponse({ error: 'maybe', code: 'outcome_unknown' }, 500),
    );
    await expect(broken.actions.apply(action, 'k')).rejects.toBeInstanceOf(
      AssistantHttpError,
    );
    const offline = client(() => {
      throw new TypeError('network down');
    });
    await expect(offline.actions.apply(action, 'k')).rejects.toThrow(
      'network down',
    );
    const previewFail = client(() => jsonResponse({ error: 'nope' }, 403));
    await expect(previewFail.actions.preview(action)).rejects.toThrow('nope');
  });

  it('refuses before the network when the surface has no revision', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const actions = createAssistantHttpActionClient({
      endpoint: '/api/assistant',
      fetchImpl,
      registry: { inspect: () => undefined },
    });
    await expect(actions.preview(action)).rejects.toThrow(/not mounted/);
    expect(fetchImpl).not.toHaveBeenCalled();
    const override = createAssistantHttpActionClient({
      endpoint: '/api/assistant',
      fetchImpl: (async () =>
        jsonResponse({ result: { ok: true } })) as unknown as typeof fetch,
      registry: { inspect: () => undefined },
      expectedRevision: () => 2,
    });
    await expect(override.preview(action)).resolves.toMatchObject({ ok: true });
  });
});

describe('createAssistantHttpTransport', () => {
  it('surfaces the server’s safe error text and adds host headers', async () => {
    const seen: Headers[] = [];
    const transport = createAssistantHttpTransport({
      endpoint: '/api/assistant',
      headers: () => ({ 'x-csrf': 't' }),
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return jsonResponse(
          { error: 'Sign in to use the assistant.', code: 'unauthenticated' },
          401,
        );
      }) as unknown as typeof fetch,
    });
    const error = await transport.createThread('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantHttpError);
    expect(error).toMatchObject({
      message: 'Sign in to use the assistant.',
      status: 401,
      code: 'unauthenticated',
    });
    await expect(
      transport.sendMessage({
        threadId: 't',
        content: 'hi',
        clientRequestId: 'c',
      }),
    ).rejects.toThrow('Sign in to use the assistant.');
    expect(seen[0].get('x-csrf')).toBe('t');
    expect(seen[0].has('authorization')).toBe(false);
  });
});
