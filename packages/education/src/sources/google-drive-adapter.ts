import type {
  DriveAcquisition,
  DriveAcquisitionOptions,
  DriveFileMetadata,
  DriveMetadataPage,
  DriveMetadataPageOptions,
  GoogleDriveProvider,
} from '@happyvertical/files';
import type {
  CatalogAcquireAdapter,
  CatalogSourceRecord,
  CatalogSyncAdapter,
  CatalogSyncPage,
} from '../catalog-contracts.js';

export type {
  DriveAcquisition,
  DriveAcquisitionOptions,
  DriveFileMetadata,
  DriveMetadataPage,
  DriveMetadataPageOptions,
};

/**
 * Metadata-only Google Drive curriculum discovery.
 *
 * This module deliberately accepts the public @happyvertical/files Drive
 * surface as a port. Hosts construct that SDK provider with their own
 * application credentials and pass it here; neither discovery records nor
 * checkpoints contain credentials or downloaded content.
 */

export const DRIVE_CURRICULUM_SEED_ROOTS = [
  {
    id: '1K_au1upSRuakX55PF3aZzQLHWI70KwZd',
    title: 'Carnival of Collisions (Contact Forces)',
  },
  {
    id: '1N1xFJ2omm-M1TuAxDOXQxZndkw70-KxM',
    title: 'Mission Maglev (Electric and Magnetic Forces)',
  },
  {
    id: '1v0LXs7iky2R4FsiqZkWOjWyJmRu-aVIa',
    title: 'Rocks vs. Big Rigs, Unit-Wide View',
  },
  {
    id: '1sFDNXdw8q-xrhgy8HFAMELXUoqKgp9tu',
    title: 'Operation Space Jump (Gravitational Forces)',
  },
] as const;

const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** The adapter only uses public SDK methods, never a raw Google API client. */
export type GoogleDriveFilesClient = Pick<
  GoogleDriveProvider,
  'listMetadataPage' | 'getMetadataById' | 'acquireById'
>;

export interface DriveCatalogRecord extends CatalogSourceRecord {
  providerId: 'google-drive';
  checksum?: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
}

export interface DriveExclusion {
  stableId: string;
  reason:
    | 'missing-revision'
    | 'shortcut-target-inaccessible'
    | 'shortcut-target-outside-boundary'
    | 'shortcut-target-unsupported';
}

interface FolderCursor {
  folderId: string;
  pageToken?: string;
  visibility: 'catalog' | 'teacher';
}

/** Serializable traversal state; persist it after every returned page. */
export interface DriveDiscoveryCheckpoint {
  version: 1;
  roots: string[];
  pendingFolders: FolderCursor[];
  visitedFolders: string[];
}

export interface DriveDiscoveryPage {
  records: DriveCatalogRecord[];
  exclusions: DriveExclusion[];
  checkpoint?: DriveDiscoveryCheckpoint;
  complete: boolean;
}

export interface DriveDiscoveryOptions {
  /** Defaults to the four owner-authorized curriculum roots. */
  roots?: readonly { id: string; title?: string }[];
  checkpoint?: DriveDiscoveryCheckpoint;
  pageSize?: number;
  /**
   * Exact Drive file IDs the trusted host has reviewed as learner-safe.
   * Folder IDs never grant visibility to their contents.
   */
  studentSafeFileIds?: readonly string[];
  /**
   * Shortcut targets are re-read by ID and must pass this host boundary check
   * before a folder can enter traversal. The secure default is deny.
   */
  authorizeShortcutTarget?: (
    target: DriveFileMetadata,
    context: { sourceFolderId: string; configuredRootIds: readonly string[] },
  ) => boolean | Promise<boolean>;
}

export interface DriveSelectionAuthorization {
  stableId: string;
  revision: string;
  exportMimeType?: string;
  /** True only after the host's resource-level license policy allows use. */
  allowed: boolean;
}

export interface PinnedDriveContent {
  stableId: string;
  revision?: string;
  checksum?: string;
  sha256: string;
  bytes: Buffer;
  exportMimeType?: string;
}

function uniqueRoots(
  roots: readonly { id: string; title?: string }[],
): readonly { id: string; title?: string }[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    if (!root.id || seen.has(root.id)) return false;
    seen.add(root.id);
    return true;
  });
}

function assertPageSize(pageSize: number | undefined): number | undefined {
  if (pageSize === undefined) return undefined;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000)
    throw new Error('Drive metadata page size must be between 1 and 1000.');
  return pageSize;
}

function classify(
  name: string,
  inherited: 'catalog' | 'teacher',
): 'catalog' | 'teacher' {
  const normalized = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_./-]+/g, ' ')
    .toLowerCase();
  if (/\b(answers?|solutions?|keys?)\b/.test(normalized)) return 'teacher';
  if (/\b(teachers?|educators?|instructors?|facilitators?)\b/.test(normalized))
    return 'teacher';
  return inherited;
}

function isFolder(metadata: DriveFileMetadata): boolean {
  return metadata.mimeType === GOOGLE_FOLDER_MIME;
}

function nativeExportFormats(mimeType: string): string[] {
  if (
    [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
    ].includes(mimeType)
  )
    return ['application/pdf'];
  return [mimeType];
}

function encodeCheckpoint(checkpoint: DriveDiscoveryCheckpoint): string {
  return Buffer.from(JSON.stringify(checkpoint)).toString('base64url');
}

function decodeCheckpoint(
  cursor: string | undefined,
): DriveDiscoveryCheckpoint | undefined {
  if (!cursor) return undefined;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (!decoded || typeof decoded !== 'object')
      throw new Error('not an object');
    return decoded as DriveDiscoveryCheckpoint;
  } catch {
    throw new Error('Invalid Google Drive discovery cursor.');
  }
}

function toRecord(
  metadata: DriveFileMetadata,
  parentStableId: string,
  inheritedVisibility: 'catalog' | 'teacher',
  studentSafeFileIds: ReadonlySet<string>,
): DriveCatalogRecord {
  const revision =
    metadata.revisionId ??
    metadata.md5Checksum ??
    metadata.modifiedTime?.toISOString();
  if (!revision)
    throw new Error(`Drive metadata for ${metadata.id} has no revision.`);
  return {
    providerId: 'google-drive',
    stableId: metadata.id,
    revision,
    ...(metadata.md5Checksum ? { checksum: metadata.md5Checksum } : {}),
    canonicalUrl: `https://drive.google.com/open?id=${encodeURIComponent(metadata.id)}`,
    title: metadata.name,
    resourceType: metadata.shortcutDetails
      ? 'shortcut'
      : isFolder(metadata)
        ? 'folder'
        : 'file',
    parentStableId,
    availableFormats: nativeExportFormats(metadata.mimeType),
    mimeType: metadata.mimeType,
    ...(metadata.size === undefined ? {} : { size: metadata.size }),
    ...(metadata.modifiedTime
      ? { modifiedTime: metadata.modifiedTime.toISOString() }
      : {}),
    visibility:
      !isFolder(metadata) &&
      studentSafeFileIds.has(metadata.id) &&
      classify(metadata.name, inheritedVisibility) === 'catalog'
        ? 'catalog'
        : 'teacher',
    licenseEvidence: { state: 'unknown' },
  };
}

function normalizedCheckpoint(
  options: DriveDiscoveryOptions,
): DriveDiscoveryCheckpoint {
  const roots = uniqueRoots(options.roots ?? DRIVE_CURRICULUM_SEED_ROOTS).map(
    (root) => root.id,
  );
  if (!roots.length) throw new Error('At least one Drive root is required.');
  const checkpoint = options.checkpoint;
  if (!checkpoint) {
    return {
      version: 1,
      roots,
      pendingFolders: roots.map((folderId) => ({
        folderId,
        visibility: 'catalog',
      })),
      visitedFolders: [],
    };
  }
  if (
    checkpoint.version !== 1 ||
    checkpoint.roots.length !== roots.length ||
    checkpoint.roots.some((root, index) => root !== roots[index])
  )
    throw new Error('Drive checkpoint does not match configured roots.');
  return {
    version: 1,
    roots,
    pendingFolders: checkpoint.pendingFolders.map((folder) => ({ ...folder })),
    visitedFolders: [...checkpoint.visitedFolders],
  };
}

/**
 * One call reads at most one Drive metadata page. Repeated calls with the
 * returned checkpoint provide durable pagination without content acquisition.
 */
export class GoogleDriveCurriculumAdapter
  implements CatalogSyncAdapter, CatalogAcquireAdapter
{
  static readonly providerId = 'google-drive';
  constructor(
    private readonly drive: GoogleDriveFilesClient,
    private readonly configuration: Omit<
      DriveDiscoveryOptions,
      'checkpoint'
    > & {
      maxAcquisitionBytes?: number;
    } = {},
  ) {}

  async enumerate(input: { cursor?: string }): Promise<CatalogSyncPage> {
    const page = await this.discover({
      ...this.configuration,
      checkpoint: decodeCheckpoint(input.cursor),
    });
    return {
      records: page.records,
      complete: page.complete,
      ...(page.checkpoint
        ? { nextCursor: encodeCheckpoint(page.checkpoint) }
        : {}),
      ...(page.exclusions.length
        ? {
            exclusions: page.exclusions.map((exclusion) => ({
              code: exclusion.reason,
              message: `Google Drive resource ${exclusion.stableId} was excluded: ${exclusion.reason}.`,
            })),
          }
        : {}),
    };
  }

  async discover(
    options: DriveDiscoveryOptions = {},
  ): Promise<DriveDiscoveryPage> {
    const checkpoint = normalizedCheckpoint(options);
    const pageSize = assertPageSize(options.pageSize);
    const current = checkpoint.pendingFolders.shift();
    if (!current) return { records: [], exclusions: [], complete: true };

    const page = await this.drive.listMetadataPage({
      folderId: current.folderId,
      ...(current.pageToken ? { pageToken: current.pageToken } : {}),
      ...(pageSize === undefined ? {} : { pageSize }),
    });
    const records: DriveCatalogRecord[] = [];
    const exclusions: DriveExclusion[] = [];
    const seenRecordIds = new Set<string>();
    const seenFolders = new Set(checkpoint.visitedFolders);
    seenFolders.add(current.folderId);

    const studentSafeFileIds = new Set(options.studentSafeFileIds ?? []);
    for (const entry of page.entries) {
      if (!entry.id || seenRecordIds.has(entry.id)) continue;
      seenRecordIds.add(entry.id);
      const inheritedVisibility = classify(entry.name, current.visibility);
      let recordEntry = entry;
      if (
        entry.shortcutDetails &&
        entry.shortcutDetails.targetMimeType !== GOOGLE_FOLDER_MIME
      ) {
        try {
          recordEntry = await this.drive.getMetadataById(
            entry.shortcutDetails.targetId,
          );
        } catch {
          exclusions.push({
            stableId: entry.shortcutDetails.targetId,
            reason: 'shortcut-target-inaccessible',
          });
          continue;
        }
        if (isFolder(recordEntry)) {
          exclusions.push({
            stableId: recordEntry.id,
            reason: 'shortcut-target-unsupported',
          });
          continue;
        }
      }
      try {
        records.push(
          toRecord(
            recordEntry,
            current.folderId,
            inheritedVisibility,
            studentSafeFileIds,
          ),
        );
      } catch {
        exclusions.push({
          stableId: entry.id,
          reason: 'missing-revision',
        });
        continue;
      }
      const visibility = inheritedVisibility;
      if (entry.shortcutDetails) {
        await this.resolveShortcut(
          entry.shortcutDetails,
          current.folderId,
          visibility,
          checkpoint,
          seenFolders,
          options,
          exclusions,
        );
      } else if (isFolder(entry) && !seenFolders.has(entry.id)) {
        seenFolders.add(entry.id);
        checkpoint.pendingFolders.push({ folderId: entry.id, visibility });
      }
    }

    if (page.nextPageToken) {
      checkpoint.pendingFolders.unshift({
        ...current,
        pageToken: page.nextPageToken,
      });
    } else {
      seenFolders.add(current.folderId);
    }
    checkpoint.visitedFolders = [...seenFolders].sort();
    return {
      records,
      exclusions,
      ...(checkpoint.pendingFolders.length ? { checkpoint } : {}),
      complete: checkpoint.pendingFolders.length === 0,
    };
  }

  private async resolveShortcut(
    shortcut: NonNullable<DriveFileMetadata['shortcutDetails']>,
    sourceFolderId: string,
    inheritedVisibility: 'catalog' | 'teacher',
    checkpoint: DriveDiscoveryCheckpoint,
    seenFolders: Set<string>,
    options: DriveDiscoveryOptions,
    exclusions: DriveExclusion[],
  ): Promise<void> {
    if (shortcut.targetMimeType !== GOOGLE_FOLDER_MIME) {
      exclusions.push({
        stableId: shortcut.targetId,
        reason: 'shortcut-target-unsupported',
      });
      return;
    }
    let target: DriveFileMetadata;
    try {
      target = await this.drive.getMetadataById(shortcut.targetId);
    } catch {
      exclusions.push({
        stableId: shortcut.targetId,
        reason: 'shortcut-target-inaccessible',
      });
      return;
    }
    if (
      !isFolder(target) ||
      seenFolders.has(target.id) ||
      (await options.authorizeShortcutTarget?.(target, {
        sourceFolderId,
        configuredRootIds: checkpoint.roots,
      })) !== true
    ) {
      exclusions.push({
        stableId: target.id,
        reason: isFolder(target)
          ? 'shortcut-target-outside-boundary'
          : 'shortcut-target-unsupported',
      });
      return;
    }
    seenFolders.add(target.id);
    checkpoint.pendingFolders.push({
      folderId: target.id,
      visibility: classify(target.name, inheritedVisibility),
    });
  }

  /**
   * Content is available only after explicit selection and policy approval.
   * A revision is mandatory so retries cannot silently acquire changed bytes.
   */
  async acquireSelected(
    authorization: DriveSelectionAuthorization,
    options: Omit<DriveAcquisitionOptions, 'expectedRevision'>,
  ): Promise<PinnedDriveContent> {
    if (!authorization.allowed)
      throw new Error(
        'Drive content selection is not authorized by license policy.',
      );
    if (!authorization.stableId || !authorization.revision)
      throw new Error(
        'Drive selection requires a stable ID and exact revision.',
      );
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
      throw new Error(
        'Drive acquisition requires a positive maximum byte limit.',
      );
    const acquisition = await this.drive.acquireById(authorization.stableId, {
      ...options,
      expectedRevision: authorization.revision,
      ...(authorization.exportMimeType
        ? { exportMimeType: authorization.exportMimeType }
        : {}),
    });
    if (acquisition.metadata.id !== authorization.stableId)
      throw new Error('Drive acquisition returned a different resource.');
    if (
      acquisition.metadata.revisionId &&
      acquisition.metadata.revisionId !== authorization.revision
    )
      throw new Error(
        'Drive acquisition revision changed before content was pinned.',
      );
    if (acquisition.bytes.byteLength > options.maxBytes)
      throw new Error('Drive acquisition exceeds its byte limit.');
    const hash = await globalThis.crypto.subtle.digest(
      'SHA-256',
      Uint8Array.from(acquisition.bytes),
    );
    const sha256 = Buffer.from(hash).toString('hex');
    if (acquisition.contentHash.toLowerCase() !== sha256)
      throw new Error(
        'Drive acquisition content hash did not match returned bytes.',
      );
    return {
      stableId: acquisition.metadata.id,
      ...(acquisition.metadata.revisionId
        ? { revision: acquisition.metadata.revisionId }
        : {}),
      ...(acquisition.metadata.md5Checksum
        ? { checksum: acquisition.metadata.md5Checksum }
        : {}),
      sha256,
      bytes: acquisition.bytes,
      ...(acquisition.exportMimeType
        ? { exportMimeType: acquisition.exportMimeType }
        : {}),
    };
  }

  async acquire(input: {
    providerId: string;
    stableId: string;
    revision: string;
    format: string;
  }): Promise<{ bytes: Uint8Array; sha256: string; revision: string }> {
    if (input.providerId !== GoogleDriveCurriculumAdapter.providerId)
      throw new Error('Google Drive adapter cannot acquire another provider.');
    const acquired = await this.acquireSelected(
      {
        stableId: input.stableId,
        revision: input.revision,
        exportMimeType: input.format,
        allowed: true,
      },
      { maxBytes: this.configuration.maxAcquisitionBytes ?? 25_000_000 },
    );
    if (acquired.revision !== input.revision)
      throw new Error(
        'Drive acquisition did not return the selected revision.',
      );
    return {
      bytes: acquired.bytes,
      sha256: acquired.sha256,
      revision: input.revision,
    };
  }
}
