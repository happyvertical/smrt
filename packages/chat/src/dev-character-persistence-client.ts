import type { PhotoCutoutRig } from '@happyvertical/animation';

export interface PersistedCharacterSetup {
  pngDataUrl: string;
  rig: PhotoCutoutRig;
  savedAt: string;
}

export interface DevCharacterPersistenceClient {
  load(): Promise<PersistedCharacterSetup | null>;
  save(
    setup: Pick<PersistedCharacterSetup, 'pngDataUrl' | 'rig'>,
  ): Promise<{ savedAt: string }>;
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
    async load() {
      const body = await response(
        await request('/api/dev-character-persistence'),
      );
      const setup = body.setup;
      if (setup === null) return null;
      if (!setup || typeof setup !== 'object' || Array.isArray(setup))
        throw new Error('Saved character setup is malformed.');
      const value = setup as Record<string, unknown>;
      if (
        typeof value.pngDataUrl !== 'string' ||
        typeof value.savedAt !== 'string'
      )
        throw new Error('Saved character setup is malformed.');
      return {
        pngDataUrl: value.pngDataUrl,
        rig: value.rig as PhotoCutoutRig,
        savedAt: value.savedAt,
      };
    },
    async save(setup) {
      const body = await response(
        await request('/api/dev-character-persistence', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(setup),
        }),
      );
      if (typeof body.savedAt !== 'string')
        throw new Error('Character save returned an invalid response.');
      return { savedAt: body.savedAt };
    },
  };
}
