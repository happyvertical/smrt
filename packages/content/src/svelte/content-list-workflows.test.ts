import { describe, expect, it, vi } from 'vitest';
import type { ContentListWorkflowRequest } from './content-list-workflows.js';
import {
  ContentListWorkflowError,
  contentListWorkflowOutcomes,
  createContentListWorkflowTransport,
} from './content-list-workflows.js';

function request(): ContentListWorkflowRequest {
  return {
    version: 1,
    requestId: 'workflow-1',
    identity: { surfaceId: 'content-list', kind: 'table' },
    actionId: 'mark-draft',
    phase: 'preview',
    selection: { scope: 'explicit-ids', rowIds: ['content-1'] },
    expectedRevision: 3,
    target: { expectedCount: 1 },
  };
}

describe('ContentList workflow transport', () => {
  it('posts the same preview/apply contract and unwraps a host envelope', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          action: 'contentListAction',
          result: { ...request(), ok: true, confirmationToken: 'token-1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createContentListWorkflowTransport({
      apiBaseUrl: '/custom',
      path: 'bulk',
      fetch,
    });

    await expect(client.preview(request())).resolves.toMatchObject({
      ok: true,
      confirmationToken: 'token-1',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/custom/bulk');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      phase: 'preview',
      expectedRevision: 3,
      target: { expectedCount: 1 },
    });
  });

  it('rejects a non-JSON response instead of reporting a successful workflow', async () => {
    const client = createContentListWorkflowTransport({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response('not json', { status: 200 })),
    });

    await expect(client.preview(request())).rejects.toMatchObject({
      name: 'ContentListWorkflowError',
      reason: 'invalid_json',
      status: 200,
    });
  });

  it.each([
    {
      label: 'request',
      response: { requestId: 'another-request' },
    },
    {
      label: 'identity',
      response: {
        identity: { surfaceId: 'another-list', kind: 'table' },
      },
    },
  ])('rejects a direct result for another $label', async ({ response }) => {
    const client = createContentListWorkflowTransport({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ ...request(), ok: true, ...response }),
            { status: 200 },
          ),
        ),
    });

    await expect(client.preview(request())).rejects.toMatchObject({
      reason: 'invalid_result',
    });
  });

  it('resolves authenticated background job status when the host configures it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          job: { jobId: 'job/a', status: 'failed', reason: 'timeout' },
        }),
        { status: 200 },
      ),
    );
    const client = createContentListWorkflowTransport({
      apiBaseUrl: '/custom',
      jobStatusPath: 'jobs/{jobId}',
      fetch,
    });

    await expect(client.status?.('job/a')).resolves.toMatchObject({
      jobId: 'job/a',
      status: 'failed',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('/custom/jobs/job%2Fa');
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('rejects a job status response for a different job', async () => {
    const client = createContentListWorkflowTransport({
      jobStatusPath: 'jobs/{jobId}',
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ jobId: 'job-b', status: 'succeeded' }),
            { status: 200 },
          ),
        ),
    });

    await expect(client.status?.('job-a')).rejects.toMatchObject({
      reason: 'invalid_job_status',
    });
  });

  it('rejects a terminal job result that is not an apply result', async () => {
    const client = createContentListWorkflowTransport({
      jobStatusPath: 'jobs/{jobId}',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            jobId: 'job-a',
            status: 'succeeded',
            result: { ...request(), ok: true, phase: 'preview' },
          }),
          { status: 200 },
        ),
      ),
    });

    await expect(client.status?.('job-a')).rejects.toMatchObject({
      reason: 'invalid_job_result',
    });
  });

  it('classifies network and HTTP failures without trusting server messages', async () => {
    const network = createContentListWorkflowTransport({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error('offline')),
    });
    await expect(network.preview(request())).rejects.toMatchObject({
      reason: 'network_failure',
    });

    const unreadableBody = createContentListWorkflowTransport({
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockRejectedValue(new Error('private stream detail')),
      } as unknown as Response),
    });
    await expect(unreadableBody.preview(request())).rejects.toMatchObject({
      reason: 'network_failure',
      status: 200,
    });

    const http = createContentListWorkflowTransport({
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { message: 'private server detail' } }),
            { status: 503 },
          ),
        ),
    });
    await expect(http.preview(request())).rejects.toMatchObject({
      reason: 'http_error',
      status: 503,
    });
  });

  it.each([
    {
      label: 'preview',
      invoke: (client: ReturnType<typeof createContentListWorkflowTransport>) =>
        client.preview(request()),
    },
    {
      label: 'apply',
      invoke: (client: ReturnType<typeof createContentListWorkflowTransport>) =>
        client.apply({ ...request(), phase: 'apply' }),
    },
    {
      label: 'job status',
      invoke: (client: ReturnType<typeof createContentListWorkflowTransport>) =>
        client.status?.('job-a'),
    },
  ])('classifies a rejected header provider for $label', async ({ invoke }) => {
    const client = createContentListWorkflowTransport({
      jobStatusPath: 'jobs/{jobId}',
      headers: vi.fn().mockRejectedValue(new Error('private auth detail')),
      fetch: vi.fn<typeof globalThis.fetch>(),
    });

    await expect(invoke(client)).rejects.toMatchObject({
      name: 'ContentListWorkflowError',
      reason: 'network_failure',
    });
  });

  it('classifies invalid configured headers without exposing constructor detail', async () => {
    const client = createContentListWorkflowTransport({
      headers: () => ({ 'bad header\n': 'value' }) as HeadersInit,
      fetch: vi.fn<typeof globalThis.fetch>(),
    });

    await expect(client.preview(request())).rejects.toMatchObject({
      name: 'ContentListWorkflowError',
      reason: 'network_failure',
    });
  });

  it('retains only valid accepted, skipped, and failed row outcomes', () => {
    expect(
      contentListWorkflowOutcomes({
        ...request(),
        ok: true,
        details: {
          outcomes: [
            { rowId: 'a', status: 'accepted' },
            { rowId: 'b', status: 'skipped', reason: 'not_ready' },
            { rowId: 'c', status: 'failed' },
            { rowId: 'd', status: 'unknown' },
          ],
        },
      }),
    ).toEqual([
      { rowId: 'a', status: 'accepted' },
      { rowId: 'b', status: 'skipped', reason: 'not_ready' },
      { rowId: 'c', status: 'failed' },
    ]);
  });
});
