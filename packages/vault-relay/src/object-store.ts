/**
 * Ciphertext object storage. The relay stores opaque chunk bytes under keys it
 * derives itself (`v1/<account handle>/<upload id>/<chunk index>.<object id>`,
 * the object id random per write attempt, so no write can replace an object a
 * commit already verified); no client string ever becomes part of a key. {@link assertObjectKey} enforces that
 * shape at the store boundary as a second line of defence against path
 * traversal.
 */
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type {
  FilesystemInterface,
  GetFilesystemOptions,
} from '@happyvertical/files';

const OBJECT_KEY =
  /^v1\/[0-9a-f]{64}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(0|[1-9][0-9]{0,5})\.[0-9a-f]{32}$/;
/** Build the object key of one stored attempt of one chunk of one upload. */
export function chunkObjectKey(
  accountHandle: string,
  uploadId: string,
  index: number,
  objectId: string,
): string {
  const key = `v1/${accountHandle}/${uploadId}/${index}.${objectId}`;
  assertObjectKey(key);
  return key;
}

/** Throw unless `key` is a relay-derived chunk key. */
export function assertObjectKey(key: string): void {
  if (!OBJECT_KEY.test(key)) {
    throw new Error('vault relay: invalid object key');
  }
}

/** Storage for opaque ciphertext chunks. */
export interface VaultObjectStore {
  /** Store `data` under `key`, replacing any previous object atomically. */
  put(key: string, data: Uint8Array): Promise<void>;
  /** The stored bytes, or `null` when the object does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Remove one object; a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** Readiness probe: resolves when the store is reachable. */
  check(): Promise<void>;
}

/**
 * Filesystem store for tests and single-node development. Writes go to a
 * temporary sibling and are renamed into place, so a reader never sees a
 * partially written chunk.
 */
export class FilesystemObjectStore implements VaultObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    assertObjectKey(key);
    const path = resolve(this.root, ...key.split('/'));
    const rel = relative(this.root, path);
    if (rel.startsWith('..') || rel.includes(`..${sep}`) || rel === '') {
      throw new Error('vault relay: object key escapes the store root');
    }
    return path;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = join(dirname(path), `.tmp-${randomUUID()}`);
    try {
      await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    // Remove the upload directory once it is empty; ignore anything else.
    try {
      const dir = dirname(path);
      if ((await readdir(dir)).length === 0) await rmdir(dir);
    } catch {
      // Best effort only.
    }
  }

  async check(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
}

/**
 * Adapter over an `@happyvertical/files` filesystem. With the S3 provider it
 * stores chunks in an S3-compatible bucket such as Garage.
 */
export class FilesObjectStore implements VaultObjectStore {
  private readonly filesystem: FilesystemInterface;
  private readonly isNotFound: (error: unknown) => boolean;

  constructor(
    filesystem: FilesystemInterface,
    isNotFound: (error: unknown) => boolean = defaultIsNotFound,
  ) {
    this.filesystem = filesystem;
    this.isNotFound = isNotFound;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    assertObjectKey(key);
    await this.filesystem.write(key, Buffer.from(data));
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertObjectKey(key);
    try {
      const content = await this.filesystem.read(key, { raw: true });
      return typeof content === 'string'
        ? new Uint8Array(Buffer.from(content, 'binary'))
        : new Uint8Array(content);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    try {
      await this.filesystem.delete(key);
    } catch (error) {
      if (!this.isNotFound(error)) throw error;
    }
  }

  async check(): Promise<void> {
    // A lookup of a key that never exists: proves reachability and
    // credentials (a denied request throws) without listing any content.
    await this.filesystem.exists('v1/readiness-probe');
  }
}

function defaultIsNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'FileNotFoundError';
}

/** S3-compatible bucket settings; credentials come from the environment. */
export interface S3ObjectStoreOptions {
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Garage needs path-style addressing; defaults to `true`. */
  forcePathStyle?: boolean;
}

/**
 * Open an S3-compatible store (Garage in deployment). The files SDK is loaded
 * on demand so library consumers that only use the filesystem store never
 * import the AWS client.
 */
export async function createS3ObjectStore(
  options: S3ObjectStoreOptions,
): Promise<FilesObjectStore> {
  const files = await import('@happyvertical/files');
  const settings: GetFilesystemOptions = {
    type: 's3',
    bucket: options.bucket,
    region: options.region,
    endpoint: options.endpoint,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    forcePathStyle: options.forcePathStyle ?? true,
  };
  const filesystem = await files.getFilesystem(settings);
  return new FilesObjectStore(
    filesystem,
    (error) => error instanceof files.FileNotFoundError,
  );
}
