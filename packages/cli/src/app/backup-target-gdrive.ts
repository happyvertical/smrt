/**
 * Google Drive backup target (#4804), through the SDK `@happyvertical/files`
 * Google Drive provider. Local tier: needs no entitlement.
 *
 * - Credentials come from the user's own credential store through the
 *   {@link DriveCredentials} seam; this module never reads, writes or prints a
 *   token, and every error message is fixed text.
 * - The OAuth grant must be narrow: `drive.file` (files this app created) or
 *   `drive.appdata`. Full Drive, read-only Drive and metadata scopes are
 *   refused before any request is made.
 * - A snapshot is uploaded to `<folder>/staging/`, its stored size checked,
 *   then moved into `<folder>/snapshots/` in one call. Only `snapshots/` is
 *   listed, so an interrupted upload is never visible.
 *
 * The SDK provider reads and writes whole buffers, so snapshots are held in
 * memory up to `maxBytes` (default 512 MiB). Larger snapshots need the file or
 * vault target. Prune moves files to the user's Drive trash.
 */

import { randomBytes } from 'node:crypto';
import type { FilesystemInterface } from '@happyvertical/files';
import {
  type BackupObject,
  type BackupPutRequest,
  type BackupTarget,
  BackupTargetError,
  objectNameForSequence,
  sequenceFromObjectName,
  sliceBuffer,
  sortNewestFirst,
  verifiedCiphertext,
} from './backup-targets.js';

/** Files created by this app only. The narrowest scope the SDK provider serves. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** The hidden per-app data folder. Preferred, but not served by the SDK provider yet. */
export const DRIVE_APPDATA_SCOPE =
  'https://www.googleapis.com/auth/drive.appdata';

const ALLOWED_SCOPES: ReadonlySet<string> = new Set([
  DRIVE_FILE_SCOPE,
  DRIVE_APPDATA_SCOPE,
]);

/** Default in-memory ceiling for one Drive snapshot. */
export const DEFAULT_DRIVE_MAX_BYTES = 512 * 1024 * 1024;

/** OAuth material for one Drive account, held by the user's credential store. */
export interface DriveCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Space-separated scopes the refresh token was granted. */
  scope: string;
}

/** The slice of the SDK filesystem interface this target uses. */
export type DriveFilesystem = Pick<
  FilesystemInterface,
  | 'exists'
  | 'read'
  | 'write'
  | 'delete'
  | 'list'
  | 'createDirectory'
  | 'move'
  | 'getStats'
>;

/**
 * Refuse any grant wider than the two app-scoped scopes. The scope is what
 * the credential store recorded when the user consented; the SDK provider
 * cannot narrow an OAuth grant after the fact.
 */
export function assertNarrowDriveScope(scope: unknown): string[] {
  const scopes =
    typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [];
  if (scopes.length === 0) {
    throw new BackupTargetError(
      'scope_too_wide',
      'The Google Drive authorization does not record its scope; reconnect it with the drive.file scope.',
    );
  }
  if (!scopes.every((entry) => ALLOWED_SCOPES.has(entry))) {
    throw new BackupTargetError(
      'scope_too_wide',
      'The Google Drive authorization is wider than backups need; reconnect it with only the drive.file scope.',
    );
  }
  return scopes;
}

/**
 * Build the SDK Google Drive filesystem for an OAuth grant. Only `drive.file`
 * is served: the provider lists with `'<folder>' in parents` and passes no
 * `spaces=appDataFolder`, so an app-data grant cannot be used through it.
 */
export async function createGoogleDriveFilesystem(
  credentials: DriveCredentials,
): Promise<DriveFilesystem> {
  const scopes = assertNarrowDriveScope(credentials.scope);
  if (!scopes.includes(DRIVE_FILE_SCOPE)) {
    throw new BackupTargetError(
      'scope_too_wide',
      'The SDK Google Drive provider cannot use an app-data-only authorization yet; reconnect with the drive.file scope.',
    );
  }
  if (
    !credentials.clientId ||
    !credentials.clientSecret ||
    !credentials.refreshToken
  ) {
    throw new BackupTargetError(
      'credentials_unavailable',
      'The Google Drive credentials are incomplete.',
    );
  }
  const { getFilesystem } = await import('@happyvertical/files');
  return getFilesystem({
    type: 'gdrive',
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    refreshToken: credentials.refreshToken,
    createMissing: false,
  });
}

const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OBJECT_ID = /^snapshot-\d{20}\.hvsnap$/;

/** Validate a Drive folder name (it is interpolated into Drive queries). */
export function assertDriveFolderName(folder: unknown): string {
  if (typeof folder !== 'string' || !FOLDER_NAME.test(folder)) {
    throw new BackupTargetError(
      'invalid_config',
      'The Drive folder name may use letters, digits, dot, dash and underscore only.',
    );
  }
  return folder;
}

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
}

/**
 * Map an SDK or Google error to a stable, fixed-text failure. The provider's
 * own message is only pattern-matched, never forwarded.
 */
export function mapDriveError(error: unknown): BackupTargetError {
  if (error instanceof BackupTargetError) return error;
  const { name, code, message } = (error ?? {}) as ErrorLike;
  const text = typeof message === 'string' ? message : '';
  if (name === 'FileNotFoundError') {
    return new BackupTargetError('not_found', 'Unknown snapshot.');
  }
  if (
    /invalid_grant|invalid_client|unauthorized_client|invalid_token|token has been (expired|revoked)|authentication failed/i.test(
      text,
    ) ||
    (name === 'FilesystemError' && code === 'EACCES')
  ) {
    return new BackupTargetError(
      'grant_expired',
      'Google Drive no longer accepts the saved authorization (expired or revoked). Reconnect your Google account for this target and try again.',
    );
  }
  if (
    name === 'PermissionError' ||
    /quota|insufficient storage|storage limit/i.test(text)
  ) {
    return new BackupTargetError(
      'quota_or_access',
      'Google Drive refused the request: your Drive storage may be full, or access to the backup folder was removed. Free space or reconnect, then retry.',
    );
  }
  return new BackupTargetError(
    'unavailable',
    'Google Drive could not be reached or returned an error. Try again later.',
  );
}

/** Options for {@link GoogleDriveBackupTarget}. */
export interface GoogleDriveBackupTargetOptions {
  name: string;
  /** Folder (created if needed) holding `snapshots/` and `staging/`. */
  folder: string;
  /** The user's credential store, resolved lazily. */
  credentials: () => Promise<DriveCredentials | undefined>;
  /** Build the filesystem; replaced in tests by a fake Drive. */
  createFilesystem?: (
    credentials: DriveCredentials,
  ) => Promise<DriveFilesystem>;
  /** In-memory ceiling for one snapshot. */
  maxBytes?: number;
}

/** Stores snapshots in the user's own Google Drive. */
export class GoogleDriveBackupTarget implements BackupTarget {
  readonly kind = 'gdrive' as const;
  readonly name: string;
  readonly #folder: string;
  readonly #credentials: () => Promise<DriveCredentials | undefined>;
  readonly #createFilesystem: (
    credentials: DriveCredentials,
  ) => Promise<DriveFilesystem>;
  readonly #maxBytes: number;
  #filesystem?: Promise<DriveFilesystem>;

  constructor(options: GoogleDriveBackupTargetOptions) {
    this.name = options.name;
    this.#folder = assertDriveFolderName(options.folder);
    this.#credentials = options.credentials;
    this.#createFilesystem =
      options.createFilesystem ?? createGoogleDriveFilesystem;
    this.#maxBytes = options.maxBytes ?? DEFAULT_DRIVE_MAX_BYTES;
  }

  get #snapshots(): string {
    return `${this.#folder}/snapshots`;
  }

  get #staging(): string {
    return `${this.#folder}/staging`;
  }

  async #drive(): Promise<DriveFilesystem> {
    this.#filesystem ??= (async () => {
      let credentials: DriveCredentials | undefined;
      try {
        credentials = await this.#credentials();
      } catch {
        throw new BackupTargetError(
          'credentials_unavailable',
          'The Google Drive credentials could not be read from the credential store.',
        );
      }
      if (!credentials) {
        throw new BackupTargetError(
          'credentials_unavailable',
          'No Google Drive credentials are stored for this target; connect your Google account first.',
        );
      }
      assertNarrowDriveScope(credentials.scope);
      try {
        return await this.#createFilesystem(credentials);
      } catch (error) {
        throw mapDriveError(error);
      }
    })();
    try {
      return await this.#filesystem;
    } catch (error) {
      this.#filesystem = undefined;
      throw error;
    }
  }

  async preflight(): Promise<void> {
    await this.#drive();
  }

  async put(request: BackupPutRequest): Promise<BackupObject> {
    if (request.byteSize > this.#maxBytes) {
      throw new BackupTargetError(
        'limit',
        'This snapshot is larger than the Google Drive target can buffer; use a file or vault target.',
      );
    }
    const name = objectNameForSequence(request.sequence);
    // Verify and buffer before touching Drive: nothing is created for a
    // plaintext, truncated or mismatched stream.
    const parts: Uint8Array[] = [];
    for await (const chunk of verifiedCiphertext(request)) parts.push(chunk);
    const body = Buffer.concat(parts, request.byteSize);

    const drive = await this.#drive();
    const finalPath = `${this.#snapshots}/${name}`;
    const stagingPath = `${this.#staging}/.${name}.${randomBytes(8).toString('hex')}`;
    let staged = false;
    try {
      await drive.createDirectory(this.#staging);
      await drive.createDirectory(this.#snapshots);
      if (await drive.exists(finalPath)) {
        throw new BackupTargetError(
          'already_exists',
          'A snapshot with this sequence already exists on the target.',
        );
      }
      staged = true;
      await drive.write(stagingPath, body);
      const stored = await drive.getStats(stagingPath);
      if (stored.size !== request.byteSize) {
        throw new BackupTargetError(
          'integrity',
          'Google Drive stored a different number of bytes than were sent.',
        );
      }
      await drive.move(stagingPath, finalPath);
      staged = false;
      const copies = (await drive.list(this.#snapshots)).filter(
        (entry) => entry.name === name,
      );
      if (copies.length !== 1) {
        throw new BackupTargetError(
          'integrity',
          'Google Drive holds more than one file with this snapshot name; remove the extra copy in Drive.',
        );
      }
      const info = await drive.getStats(finalPath);
      if (info.size !== request.byteSize) {
        throw new BackupTargetError(
          'integrity',
          'Google Drive reports a different size for the stored snapshot.',
        );
      }
      return {
        id: name,
        sequence: request.sequence,
        byteSize: info.size,
        createdAt: info.mtime,
        sha256: request.sha256,
      };
    } catch (error) {
      if (staged) await drive.delete(stagingPath).catch(() => undefined);
      throw mapDriveError(error);
    }
  }

  async list(): Promise<BackupObject[]> {
    const drive = await this.#drive();
    try {
      if (!(await drive.exists(this.#snapshots))) return [];
      const seen = new Set<string>();
      const objects: BackupObject[] = [];
      for (const entry of await drive.list(this.#snapshots)) {
        const sequence = sequenceFromObjectName(entry.name);
        if (entry.isDirectory || sequence === null) continue;
        // Drive allows two files with one name; get and delete would pick
        // one arbitrarily, so refuse to act until the extra copy is removed.
        if (seen.has(entry.name)) {
          throw new BackupTargetError(
            'integrity',
            'Google Drive holds two files with the same snapshot name; remove the extra copy in Drive.',
          );
        }
        seen.add(entry.name);
        objects.push({
          id: entry.name,
          sequence,
          byteSize: entry.size,
          createdAt: entry.lastModified,
        });
      }
      return sortNewestFirst(objects);
    } catch (error) {
      throw mapDriveError(error);
    }
  }

  #path(id: string): string {
    if (typeof id !== 'string' || !OBJECT_ID.test(id)) {
      throw new BackupTargetError('not_found', 'Unknown snapshot.');
    }
    return `${this.#snapshots}/${id}`;
  }

  async *get(id: string): AsyncGenerator<Uint8Array> {
    const path = this.#path(id);
    const drive = await this.#drive();
    let bytes: Buffer;
    try {
      const stats = await drive.getStats(path);
      if (stats.size > this.#maxBytes) {
        throw new BackupTargetError(
          'limit',
          'This snapshot is larger than the Google Drive target can buffer.',
        );
      }
      bytes = (await drive.read(path, { raw: true })) as Buffer;
      if (bytes.length !== stats.size || bytes.length > this.#maxBytes) {
        throw new BackupTargetError(
          'integrity',
          'Google Drive returned a different number of bytes than it reported.',
        );
      }
    } catch (error) {
      throw mapDriveError(error);
    }
    yield* sliceBuffer(bytes);
  }

  async delete(id: string): Promise<void> {
    const path = this.#path(id);
    const drive = await this.#drive();
    try {
      await drive.delete(path);
    } catch (error) {
      throw mapDriveError(error);
    }
  }
}
