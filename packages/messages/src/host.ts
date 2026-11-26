/** Package-private Node host primitives. Browser consumers select host.browser through the package browser map. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ProfileCollection } from '@happyvertical/smrt-profiles';
import type { DatabaseInterface } from '@happyvertical/sql';

export { isDeepStrictEqual } from 'node:util';
export { buildSqliteRebuildStatements } from '@happyvertical/smrt-core/migrations';
export { normalizeIdentityEmail } from '@happyvertical/smrt-profiles';

export interface HandoffContext<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
}
/** The caller owns this store; this module exposes no authority mint or shared store. */
export function createHandoffContext<T>(): HandoffContext<T> {
  return new AsyncLocalStorage<T>();
}
export function notificationSha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function canonicalNotificationMessageId(deliveryId: string): string {
  const bytes = createHash('sha256')
    .update(`smrt-messages:notification-delivery:${deliveryId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function assertNotificationMaintenanceHost(): void {}

/** The existing public Profile lookup stays server-only; the outbox owns current tenant/resource validation. */
export async function readNotificationProfile(
  db: DatabaseInterface,
  tenantId: string,
  profileId: string,
) {
  return (await ProfileCollection.create({ db })).get(
    { id: profileId, tenantId },
    { cache: false },
  );
}

export {
  getCurrentTenant,
  queryGlobal,
  queryWithGlobals,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';

/** Preserve the original public lazy SecretService factory; callers keep all credential/tenant checks. */
export async function createAccountSecretService(db: DatabaseInterface) {
  const { SecretService } = await import('@happyvertical/smrt-secrets');
  return SecretService.create({ db });
}

/**
 * Validate an attachment storage root and return its real path (symlinks
 * resolved once, at configuration). Throws a plain Error naming the problem.
 */
export function resolveAttachmentStorageRoot(root: unknown): string {
  if (typeof root !== 'string' || !root || !isAbsolute(root)) {
    throw new Error('the storage root must be an absolute directory path');
  }
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    throw new Error('the storage root does not exist');
  }
  if (!statSync(real).isDirectory()) {
    throw new Error('the storage root is not a directory');
  }
  return real;
}

export type AttachmentFileRead =
  | { status: 'ok'; data: Buffer }
  | { status: 'missing' }
  | { status: 'outside' };

function within(base: string, target: string): boolean {
  const rel = relative(base, target);
  return !(
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  );
}

/**
 * Read `segments` below `realRoot`. The first segment is the owner's
 * directory: its real path must stay inside the root, and the target's real
 * path (symlinks resolved) must stay inside that directory. The bytes are read
 * from the resolved path.
 */
export async function readAttachmentFileUnderRoot(
  realRoot: string,
  segments: readonly string[],
): Promise<AttachmentFileRead> {
  let ownerDir: string;
  let target: string;
  try {
    ownerDir = await realpath(join(realRoot, segments[0] ?? ''));
    target = await realpath(join(realRoot, ...segments));
  } catch {
    return { status: 'missing' };
  }
  if (!within(realRoot, ownerDir) || !within(ownerDir, target)) {
    return { status: 'outside' };
  }
  try {
    if (!(await stat(target)).isFile()) return { status: 'missing' };
    return { status: 'ok', data: await readFile(target) };
  } catch {
    return { status: 'missing' };
  }
}
