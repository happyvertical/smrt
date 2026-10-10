import { describe, expect, it, vi } from 'vitest';
import { createDevHelperClient } from './dev-helper-client.js';

const preferences = {
  version: 1,
  offeringId: 'happy',
  name: 'Happy',
  voiceId: 'marin',
  placement: 'bottom-right',
  heardSubtitles: true,
  spokenSubtitles: true,
} as const;
const snapshot = {
  preferences,
  offering: {
    id: 'happy',
    label: 'Happy',
    styleId: 'happy',
    source: 'ready-made',
  },
  selection: 'personal',
  source: 'personal',
  offerings: [],
  voices: [],
  permissions: { editableFields: [], canReset: true, customStyleIds: [] },
  hasOverride: true,
  recovery: null,
} as const;

describe('dev helper client', () => {
  it('uses only the fixed helper endpoint for load, full save, and reset', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(snapshot)));
    const client = createDevHelperClient(request);
    await expect(client.load()).resolves.toEqual(snapshot);
    await expect(client.save(preferences)).resolves.toEqual(snapshot);
    await expect(client.reset()).resolves.toEqual(snapshot);
    expect(
      request.mock.calls.map(([url, init]) => [url, init?.method]),
    ).toEqual([
      ['/api/dev-helper', 'GET'],
      ['/api/dev-helper', 'POST'],
      ['/api/dev-helper', 'DELETE'],
    ]);
    expect(String(request.mock.calls[1]?.[1]?.body)).not.toContain('tenant');
  });

  it('does not treat a failed or malformed response as applied preferences', async () => {
    const failed = createDevHelperClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: 'Denied.' }), { status: 403 }),
        ),
    );
    await expect(failed.reset()).rejects.toThrow('Denied.');
    const malformed = createDevHelperClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}')),
    );
    await expect(malformed.load()).rejects.toThrow('malformed');
  });
});
