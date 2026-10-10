import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

const ENABLED = new Set(['1', 'true', 'yes']);

export interface DevCharacterPersistenceConfig {
  databaseUrl: string;
  assetDirectory: string;
  profileId: string;
  tenantId: string;
}

function value(name: string): string | null {
  const candidate = process.env[name]?.trim();
  return candidate ? candidate : null;
}

function isTemporaryPath(path: string): boolean {
  const temporary = resolve(tmpdir());
  const candidate = resolve(path);
  return candidate === temporary || candidate.startsWith(`${temporary}${sep}`);
}

function requiredTemporaryPath(name: string): string {
  const configured = value(name);
  if (!configured || !isTemporaryPath(configured)) {
    throw new Error(`${name} must be an absolute path below ${tmpdir()}`);
  }
  return resolve(configured);
}

/**
 * Resolves the deliberately opt-in local workbench store. This is not an
 * authentication mechanism: production hosts must supply their own principal
 * and authorization policy to PhotoCutoutProfileStore.
 */
export function resolveDevCharacterPersistenceConfig(): DevCharacterPersistenceConfig | null {
  const enabled = value('SMRT_CHAT_DEV_CHARACTER_PERSISTENCE')?.toLowerCase();
  if (!enabled || !ENABLED.has(enabled)) return null;

  const profileId = value('SMRT_CHAT_DEV_CHARACTER_PROFILE_ID');
  const tenantId = value('SMRT_CHAT_DEV_CHARACTER_TENANT_ID');
  if (!profileId || !tenantId) {
    throw new Error(
      'SMRT_CHAT_DEV_CHARACTER_PROFILE_ID and SMRT_CHAT_DEV_CHARACTER_TENANT_ID are required.',
    );
  }
  return {
    databaseUrl: requiredTemporaryPath('SMRT_CHAT_DEV_CHARACTER_DATABASE_URL'),
    assetDirectory: requiredTemporaryPath('SMRT_CHAT_DEV_CHARACTER_ASSET_DIR'),
    profileId,
    tenantId,
  };
}

export function isLoopbackAddress(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

export function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}

/**
 * The URL and Host header identify the server name, not the caller. Use
 * SvelteKit's trusted connection address and fail closed when it is absent.
 */
export function isLocalDevCharacterRequest({
  dev,
  request,
  getClientAddress,
}: {
  dev: boolean;
  request: Request;
  getClientAddress: () => string;
}): boolean {
  if (!dev || !hasSameOrigin(request)) return false;
  try {
    return isLoopbackAddress(getClientAddress());
  } catch {
    return false;
  }
}
