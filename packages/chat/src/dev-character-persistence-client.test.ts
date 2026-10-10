import { describe, expect, it, vi } from 'vitest';
import { createDevCharacterPersistenceClient } from './dev-character-persistence-client.js';

describe('dev character persistence client', () => {
  it('sends only cutout bytes and rig, then reads the server-resolved setup', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            savedAt: '2026-10-07T00:00:00.000Z',
            assetId: 'asset-1',
          }),
          {
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            setup: {
              assetId: 'asset-1',
              pngDataUrl: 'data:image/png;base64,AA==',
              rig: { rigKind: 'photo-cutout' },
              savedAt: '2026-10-07T00:00:00.000Z',
            },
          }),
          { status: 200 },
        ),
      );
    const client = createDevCharacterPersistenceClient(request);
    await expect(
      client.save({
        pngDataUrl: 'data:image/png;base64,AA==',
        rig: { rigKind: 'photo-cutout' } as never,
      }),
    ).resolves.toEqual({
      savedAt: '2026-10-07T00:00:00.000Z',
      assetId: 'asset-1',
    });
    expect(request.mock.calls[0]?.[0]).toBe('/api/dev-character-persistence');
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(String(request.mock.calls[0]?.[1]?.body)).not.toContain('profile');
    await expect(client.load()).resolves.toMatchObject({
      assetId: 'asset-1',
      pngDataUrl: 'data:image/png;base64,AA==',
      savedAt: '2026-10-07T00:00:00.000Z',
    });
  });

  it('lists and fetches only server-authorized saved asset ids', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            setups: [
              {
                assetId: 'asset-2',
                savedAt: '2026-10-07T00:00:00.000Z',
                name: 'Second portrait',
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            setup: {
              assetId: 'asset-2',
              pngDataUrl: 'data:image/png;base64,AA==',
              rig: { rigKind: 'photo-cutout' },
              savedAt: '2026-10-07T00:00:00.000Z',
            },
          }),
          { status: 200 },
        ),
      );
    const client = createDevCharacterPersistenceClient(request);
    await expect(client.list()).resolves.toEqual([
      {
        assetId: 'asset-2',
        savedAt: '2026-10-07T00:00:00.000Z',
        name: 'Second portrait',
      },
    ]);
    await expect(client.load('asset-2')).resolves.toMatchObject({
      assetId: 'asset-2',
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      '/api/dev-character-persistence?list=1',
    );
    expect(request.mock.calls[1]?.[0]).toBe(
      '/api/dev-character-persistence?assetId=asset-2',
    );
  });
});
