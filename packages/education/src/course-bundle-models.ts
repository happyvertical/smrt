import {
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

const closed = { api: false, mcp: false, cli: false } as const;
const IMMUTABLE = 'Course bundle evidence is immutable';
const KINDS = [
  'pdf',
  'image',
  'text',
  'docx',
  'pptx',
  'xlsx',
  'manifest',
  'unsupported',
];
const STATUSES = [
  'accepted',
  'duplicate',
  'unsupported',
  'refused',
  'metadata',
];

function adopt(target: object, options: Record<string, unknown>) {
  for (const [key, value] of Object.entries(options))
    if (Object.hasOwn(target, key))
      (target as Record<string, unknown>)[key] = value;
}
function requireText(value: unknown, message: string, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(message);
}
function requireCount(value: unknown, message: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(message);
}
async function requireInsert(row: SmrtObject & { tenantId: string }) {
  if (!row.tenantId?.trim())
    throw new Error('Course bundle evidence requires a tenant');
  if (row.id && (await row.db.get(row.tableName, { id: row.id })))
    throw new Error(IMMUTABLE);
}
function noDelete(): never {
  throw new Error(IMMUTABLE);
}

/**
 * Append-only record of one imported course bundle (SMRT #4578), keyed by the
 * content identity of its members so re-uploading the same bundle replays.
 * Holds hashes, sizes and placements only; the bytes stay with the host's
 * ingestion receipts and are never copied here.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_bundle_imports',
  conflictColumns: ['tenant_id', 'bundle_identity'],
  indexes: [
    {
      name: 'course_bundle_imports_identity_unique',
      columns: ['tenantId', 'bundleIdentity'],
      unique: true,
    },
  ],
  ...closed,
})
export class CourseBundleImport extends SmrtObject {
  @tenantId() tenantId = '';
  /** `cbi1-` digest of the sorted (path, sha256) pairs. */
  bundleIdentity = '';
  /** `zip` or `files`. */
  format = 'zip';
  /** Reader format id that laid the bundle out (`manifest-v1`, `plain-files`). */
  readerId = '';
  /** Manifest schema version, 0 when none. */
  manifestVersion = 0;
  entryCount = 0;
  acceptedCount = 0;
  duplicateCount = 0;
  unsupportedCount = 0;
  refusedCount = 0;
  totalBytes = 0;
  importedByUserId = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    requireText(this.bundleIdentity, 'Bundle requires an identity');
    requireText(this.readerId, 'Bundle requires a reader');
    if (!['zip', 'files'].includes(this.format))
      throw new Error('Invalid bundle format');
    for (const n of [
      this.manifestVersion,
      this.entryCount,
      this.acceptedCount,
      this.duplicateCount,
      this.unsupportedCount,
      this.refusedCount,
      this.totalBytes,
    ])
      requireCount(n, 'Invalid bundle count');
    requireText(this.importedByUserId, 'Bundle requires an actor');
    if (
      !(this.recordedAt instanceof Date) ||
      !Number.isFinite(this.recordedAt.getTime())
    )
      throw new Error('Invalid bundle timestamp');
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseBundleImportCollection extends SmrtCollection<CourseBundleImport> {
  static readonly _itemClass = CourseBundleImport;
}

/**
 * Append-only evidence of one member of an imported bundle: what it was, what
 * became of it (accepted, duplicate, unsupported, refused with a typed reason)
 * and where the manifest or the plain layout placed it.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_bundle_members',
  conflictColumns: ['tenant_id', 'import_id', 'path'],
  indexes: [
    {
      name: 'course_bundle_members_path_unique',
      columns: ['tenantId', 'importId', 'path'],
      unique: true,
    },
    {
      name: 'course_bundle_members_hash',
      columns: ['tenantId', 'sha256'],
    },
  ],
  ...closed,
})
export class CourseBundleMember extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CourseBundleImport', { required: true }) importId = '';
  /** Position in the bundle's canonical order. */
  ordinal = 0;
  path = '';
  /** Empty when the member was refused as oversize and never inflated. */
  sha256 = '';
  sizeBytes = 0;
  mediaType = '';
  kind = 'unsupported';
  status = 'unsupported';
  /** Typed reason for any status other than accepted/metadata. */
  reason = '';
  /** Path of the earlier member with identical bytes. */
  duplicateOfPath = '';
  /**
   * Declared role (manifest): a page role under version 1, a material role
   * under version 2. Empty when none.
   */
  role = '';
  /** Version 2: the effective audience (`learner` or `guardian`); empty when none. */
  audience = '';
  sectionKey = '';
  lessonKey = '';
  /** sha256 of the PDF rendered from a Word/PowerPoint member; empty otherwise. */
  renderedSha256 = '';
  renderedSizeBytes = 0;
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    requireCount(this.renderedSizeBytes, 'Invalid rendered size');
    if (
      !(await this.db.get('course_bundle_imports', {
        id: this.importId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('Course bundle parent ownership mismatch');
    requireText(this.path, 'Bundle member requires a path', 512);
    requireCount(this.ordinal, 'Invalid bundle ordinal');
    requireCount(this.sizeBytes, 'Invalid bundle size');
    if (!KINDS.includes(this.kind))
      throw new Error('Invalid bundle member kind');
    if (!STATUSES.includes(this.status))
      throw new Error('Invalid bundle member status');
    if (!['accepted', 'metadata'].includes(this.status) && !this.reason)
      throw new Error('A non-accepted bundle member requires a reason');
    if ((this.status === 'duplicate') !== Boolean(this.duplicateOfPath))
      throw new Error('Only duplicates name an original');
    if (!['', 'learner', 'guardian'].includes(this.audience))
      throw new Error('Invalid bundle member audience');
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseBundleMemberCollection extends SmrtCollection<CourseBundleMember> {
  static readonly _itemClass = CourseBundleMember;
}

/**
 * Append-only record that a Word/PowerPoint member whose first rendering failed
 * was rendered later by a deliberate retry (SMRT #4615). The import's member
 * rows stay as first recorded; readers overlay this record. One row per
 * (import, content hash): a second retry of a repaired member is a replay.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_bundle_renderings',
  conflictColumns: ['tenant_id', 'import_id', 'sha256'],
  indexes: [
    {
      name: 'course_bundle_renderings_unique',
      columns: ['tenantId', 'importId', 'sha256'],
      unique: true,
    },
  ],
  ...closed,
})
export class CourseBundleRendering extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CourseBundleImport', { required: true }) importId = '';
  /** Content hash of the Word/PowerPoint member that was rendered. */
  sha256 = '';
  renderedSha256 = '';
  renderedSizeBytes = 0;
  converterId = '';
  retriedByUserId = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    requireText(this.sha256, 'Rendering requires a member hash', 64);
    requireText(this.renderedSha256, 'Rendering requires a rendered hash', 64);
    requireText(this.retriedByUserId, 'Rendering requires an actor');
    requireCount(this.renderedSizeBytes, 'Invalid rendered size');
    if (
      !(await this.db.get('course_bundle_imports', {
        id: this.importId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('Course bundle parent ownership mismatch');
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseBundleRenderingCollection extends SmrtCollection<CourseBundleRendering> {
  static readonly _itemClass = CourseBundleRendering;
}
