import type { PhotoCutoutRig } from '@happyvertical/animation';

export interface PersistedCharacterSetup {
  assetId: string;
  pngDataUrl: string;
  rig: PhotoCutoutRig;
  savedAt: string;
}

export interface SavedCharacterSetup {
  assetId: string;
  savedAt: string;
  name?: string;
}

export interface DevCharacterPersistenceClient {
  /** Omitting assetId preserves the original "latest saved" behavior. */
  load(assetId?: string): Promise<PersistedCharacterSetup | null>;
  list(): Promise<SavedCharacterSetup[]>;
  save(
    setup: Pick<PersistedCharacterSetup, 'pngDataUrl' | 'rig'>,
  ): Promise<{ savedAt: string; assetId: string }>;
}

/** Browser-safe callback seam for the local workbench only. */
export function createDevCharacterPersistenceClient(
  request: typeof fetch = fetch,
): DevCharacterPersistenceClient {
  async function response(
    response: Response,
  ): Promise<Record<string, unknown>> {
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok)
      throw new Error(
        typeof body.message === 'string'
          ? body.message
          : 'Character persistence failed.',
      );
    return body;
  }
  return {
    async load(assetId) {
      const query = assetId ? `?assetId=${encodeURIComponent(assetId)}` : '';
      const body = await response(
        await request(`/api/dev-character-persistence${query}`),
      );
      const setup = body.setup;
      if (setup === null) return null;
      if (!setup || typeof setup !== 'object' || Array.isArray(setup))
        throw new Error('Saved character setup is malformed.');
      const value = setup as Record<string, unknown>;
      if (
        typeof value.assetId !== 'string' ||
        typeof value.pngDataUrl !== 'string' ||
        typeof value.savedAt !== 'string'
      )
        throw new Error('Saved character setup is malformed.');
      return {
        assetId: value.assetId,
        pngDataUrl: value.pngDataUrl,
        rig: value.rig as PhotoCutoutRig,
        savedAt: value.savedAt,
      };
    },
    async list() {
      const body = await response(
        await request('/api/dev-character-persistence?list=1'),
      );
      if (!Array.isArray(body.setups))
        throw new Error('Saved character gallery is malformed.');
      return body.setups.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new Error('Saved character gallery is malformed.');
        const value = entry as Record<string, unknown>;
        if (
          typeof value.assetId !== 'string' ||
          typeof value.savedAt !== 'string' ||
          (value.name !== undefined && typeof value.name !== 'string')
        )
          throw new Error('Saved character gallery is malformed.');
        return {
          assetId: value.assetId,
          savedAt: value.savedAt,
          ...(typeof value.name === 'string' ? { name: value.name } : {}),
        };
      });
    },
    async save(setup) {
      const body = await response(
        await request('/api/dev-character-persistence', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(setup),
        }),
      );
      if (typeof body.savedAt !== 'string' || typeof body.assetId !== 'string')
        throw new Error('Character save returned an invalid response.');
      return { savedAt: body.savedAt, assetId: body.assetId };
    },
  };
}
