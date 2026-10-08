import {
  type PhotoCutoutRig,
  validatePhotoCutoutRig,
} from '@happyvertical/animation';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import {
  type PhotoCutoutProfileOwner,
  PhotoCutoutProfileStore,
} from '@happyvertical/smrt-images';
import { ProfileCollection } from '@happyvertical/smrt-profiles';
import { getDatabase } from '@happyvertical/sql';
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import {
  isLocalDevCharacterRequest,
  resolveDevCharacterPersistenceConfig,
} from './config.js';

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

function requireDevAccess(request: Request, getClientAddress: () => string) {
  const config = resolveDevCharacterPersistenceConfig();
  if (!config) error(404, 'Character persistence is not enabled.');
  if (!isLocalDevCharacterRequest({ dev, request, getClientAddress })) {
    error(
      403,
      'Character persistence is available only from the local workbench.',
    );
  }
  return config;
}

async function readBoundedJson(
  request: Request,
): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES)
    error(413, 'Character setup is too large.');
  const reader = request.body?.getReader();
  if (!reader) error(400, 'Character setup is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        error(413, 'Character setup is too large.');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    error(400, 'Character setup must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    error(400, 'Character setup must be an object.');
  return parsed as Record<string, unknown>;
}

function decodePng(value: unknown): Buffer {
  if (typeof value !== 'string') error(400, 'A PNG cutout is required.');
  const matched = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!matched) error(400, 'Character setup must use a PNG data URL.');
  return Buffer.from(matched[1], 'base64');
}

function rig(value: unknown): PhotoCutoutRig {
  try {
    validatePhotoCutoutRig(value);
    return value;
  } catch {
    error(422, 'Character rig is invalid.');
  }
}

/** Keep nullable ORM identifiers outside the persistence authorization seam. */
function asPhotoCutoutProfileOwner(
  profile: {
    id?: string | null;
    tenantId?: string | null;
    getAssets: PhotoCutoutProfileOwner['getAssets'];
    addAsset: PhotoCutoutProfileOwner['addAsset'];
  } | null,
): PhotoCutoutProfileOwner | null {
  if (!profile || typeof profile.id !== 'string') return null;
  return {
    id: profile.id,
    tenantId: profile.tenantId ?? null,
    getAssets: profile.getAssets.bind(profile),
    addAsset: profile.addAsset.bind(profile),
  };
}

async function withStore<T>(
  request: Request,
  getClientAddress: () => string,
  operation: (store: PhotoCutoutProfileStore) => Promise<T>,
): Promise<T> {
  const config = requireDevAccess(request, getClientAddress);
  const db = await getDatabase({ type: 'sqlite', url: config.databaseUrl });
  try {
    const profiles = await ProfileCollection.create({ db });
    const runtime = await createAssetRuntime({
      db,
      storage: config.assetDirectory,
    });
    const store = new PhotoCutoutProfileStore({
      runtime,
      getProfile: async (id) =>
        asPhotoCutoutProfileOwner(await profiles.get({ id })),
      // This local-only route fixes actor and target to the externally
      // provisioned profile. Request input never selects either identity.
      authorize: ({ actorProfileId, profile, tenantId }) =>
        actorProfileId === config.profileId &&
        profile.id === config.profileId &&
        tenantId === config.tenantId,
    });
    return await operation(store);
  } finally {
    await db.close?.();
  }
}

export const GET: RequestHandler = async ({ request, getClientAddress }) => {
  const config = requireDevAccess(request, getClientAddress);
  const url = new URL(request.url);
  if (url.searchParams.get('list') === '1') {
    const setups = await withStore(request, getClientAddress, (store) =>
      store.list({
        actorProfileId: config.profileId,
        profileId: config.profileId,
        tenantId: config.tenantId,
      }),
    );
    return json({ setups });
  }
  const assetId = url.searchParams.get('assetId') ?? undefined;
  if (assetId !== undefined && !assetId.trim())
    error(400, 'Character asset id is invalid.');
  const saved = await withStore(request, getClientAddress, (store) =>
    store.load({
      actorProfileId: config.profileId,
      profileId: config.profileId,
      tenantId: config.tenantId,
      ...(assetId ? { assetId } : {}),
    }),
  );
  if (!saved) return json({ setup: null });
  return json({
    setup: {
      assetId: saved.assetId,
      rig: saved.rig,
      savedAt: saved.savedAt,
      pngDataUrl: `data:image/png;base64,${saved.png.toString('base64')}`,
    },
  });
};

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const config = requireDevAccess(request, getClientAddress);
  const body = await readBoundedJson(request);
  const saved = await withStore(request, getClientAddress, (store) =>
    store.save({
      actorProfileId: config.profileId,
      profileId: config.profileId,
      tenantId: config.tenantId,
      png: decodePng(body.pngDataUrl),
      rig: rig(body.rig),
    }),
  );
  return json({ savedAt: saved.savedAt, assetId: saved.assetId });
};
