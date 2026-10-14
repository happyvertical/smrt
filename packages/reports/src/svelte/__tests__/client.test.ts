// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeReportsHttpClient } from '../client.js';
import { result, saved, spec } from '../preview-data.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const wire = () => ({
  id: saved.id,
  title: saved.title,
  description: '',
  sourceId: saved.sourceId,
  createdByUserId: saved.createdByUserId,
  status: saved.status,
  spec: JSON.stringify(spec),
});

describe('runtime reports HTTP client', () => {
  it('uses generated reads, principal filters, action envelopes, and session run hints', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/run')) return json({ action: 'run', result });
      if (url.endsWith('/archive'))
        return json({
          action: 'archive',
          result: { id: saved.id, status: 'archived' },
        });
      if (url.includes('?'))
        return json({ items: [wire()], count: 1, limit: 50, offset: 0 });
      return json(wire());
    });
    const client = createRuntimeReportsHttpClient({
      fetch,
      currentUserId: 'alice',
      canArchive: true,
    });

    const listed = await client.list({
      onlyMine: true,
      includeArchived: false,
    });
    expect(listed[0]).toMatchObject({ id: saved.id, canArchive: true });
    expect(String(fetch.mock.calls[0][0])).toContain(
      'status=active&createdByUserId=alice',
    );
    await client.run(saved.id);
    expect((await client.get(saved.id)).lastRunAt).toBe(result.ranAt);
    await client.archive(saved.id, true);
    expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({
      archived: true,
    });
  });

  it('confirms the exact displayed spec and hash at a same-origin path', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).includes('/confirm')
        ? json(
            { id: saved.id, specHash: result.specHash, title: saved.title },
            201,
          )
        : json(wire()),
    );
    const client = createRuntimeReportsHttpClient({ fetch });
    await client.confirm({
      status: 'awaiting_confirmation',
      spec,
      specHash: result.specHash,
      sourceLabel: 'Sales',
      confirmPath: '/api/_reports/runtime/confirm',
      preview: result,
    });
    const [, request] = fetch.mock.calls[0];
    expect(JSON.parse(String(request?.body))).toEqual({
      spec,
      specHash: result.specHash,
    });
  });

  it('fails closed on malformed envelopes and cross-origin confirmation paths', async () => {
    const client = createRuntimeReportsHttpClient({
      fetch: vi.fn(async () => json({ action: 'run', result: {} })),
    });
    await expect(client.run(saved.id)).rejects.toMatchObject({
      code: 'invalid_result',
    });
    await expect(
      client.confirm({
        status: 'awaiting_confirmation',
        spec,
        specHash: result.specHash,
        sourceLabel: 'Sales',
        confirmPath: 'https://evil.example/confirm',
        preview: result,
      }),
    ).rejects.toMatchObject({ code: 'invalid_confirm_path' });
    await expect(
      client.confirm({
        status: 'awaiting_confirmation',
        spec,
        specHash: result.specHash,
        sourceLabel: 'Sales',
        confirmPath: '//evil.example/confirm',
        preview: result,
      }),
    ).rejects.toMatchObject({ code: 'invalid_confirm_path' });
  });
});
