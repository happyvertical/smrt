import {
  field,
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
/** Attachments being handed to a newer import by `supersedeWith`. */
const swapping = new WeakSet<object>();
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

/**
 * Record that one imported bundle (a part of a unit) was attached to a family
 * course (SMRT #4632). Unique per import, and per (course, part): a unit's
 * parts merge into one course, each part once. Never rewritten or deleted
 * except that a newer build may take over its part (`supersedeWith`, #4645),
 * which is recorded in `course_bundle_supersessions`.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_bundle_attachments',
  conflictColumns: ['tenant_id', 'import_id'],
  indexes: [
    {
      name: 'course_bundle_attachments_import_unique',
      columns: ['tenantId', 'importId'],
      unique: true,
    },
    {
      name: 'course_bundle_attachments_part_unique',
      columns: ['tenantId', 'courseId', 'partIndex'],
      unique: true,
    },
  ],
  ...closed,
})
export class CourseBundleAttachment extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CourseBundleImport', { required: true }) importId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  /** The unit key (`course.key`), or `bundle:<identity>` for an unnamed bundle. */
  unitKey = '';
  partIndex = 1;
  partCount = 1;
  attachedByUserId = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  /**
   * Hand this part to a newer import of the same unit (SMRT #4645). The only
   * sanctioned change to an attachment: course, unit and part never move, and
   * the caller records the change in a `CourseBundleSupersession`.
   */
  async supersedeWith(importId: string, actorUserId: string): Promise<this> {
    swapping.add(this);
    try {
      this.importId = importId;
      this.attachedByUserId = actorUserId;
      this.recordedAt = new Date();
      return await this.save();
    } finally {
      swapping.delete(this);
    }
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    const swap = swapping.has(this);
    if (swap) {
      if (!this.tenantId?.trim())
        throw new Error('Course bundle evidence requires a tenant');
      const prior = this.id
        ? await this.db.get(this.tableName, { id: this.id })
        : null;
      if (
        !prior ||
        prior.tenant_id !== this.tenantId ||
        prior.course_id !== this.courseId ||
        prior.unit_key !== this.unitKey ||
        Number(prior.part_index) !== this.partIndex ||
        Number(prior.part_count) !== this.partCount
      )
        throw new Error(IMMUTABLE);
    } else await requireInsert(this);
    requireText(this.unitKey, 'Attachment requires a unit key', 200);
    requireText(this.attachedByUserId, 'Attachment requires an actor');
    if (
      !Number.isSafeInteger(this.partCount) ||
      !Number.isSafeInteger(this.partIndex) ||
      this.partCount < 1 ||
      this.partIndex < 1 ||
      this.partIndex > this.partCount
    )
      throw new Error('Invalid bundle part');
    if (
      !(await this.db.get('course_bundle_imports', {
        id: this.importId,
        tenant_id: this.tenantId,
      })) ||
      !(await this.db.get('courses', {
        id: this.courseId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('Course bundle parent ownership mismatch');
    if (!swap) this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseBundleAttachmentCollection extends SmrtCollection<CourseBundleAttachment> {
  static readonly _itemClass = CourseBundleAttachment;
}

/**
 * A guardian's audience choice for one material of an import, made in review
 * before the bundle is attached (SMRT #4632). One row per (import, target);
 * a later choice replaces the earlier one. `target` is `file:<member path>` or
 * `video:<lesson key>:<video id>`. Attaching applies it; after attach the
 * material's own audience is changed with `setMaterialAudience`.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_bundle_audience_choices',
  conflictColumns: ['tenant_id', 'import_id', 'target'],
  indexes: [
    {
      name: 'course_bundle_audience_choices_unique',
      columns: ['tenantId', 'importId', 'target'],
      unique: true,
    },
  ],
  ...closed,
})
export class CourseBundleAudienceChoice extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('CourseBundleImport', { required: true }) importId = '';
  target = '';
  audience = '';
  chosenByUserId = '';
  chosenAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!this.tenantId?.trim())
      throw new Error('Course bundle evidence requires a tenant');
    requireText(this.target, 'Audience choice requires a target', 700);
    requireText(this.chosenByUserId, 'Audience choice requires an actor');
    if (!['learner', 'guardian'].includes(this.audience))
      throw new Error('Invalid audience choice');
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    if (
      prior &&
      (prior.tenant_id !== this.tenantId ||
        prior.import_id !== this.importId ||
        prior.target !== this.target)
    )
      throw new Error('An audience choice cannot move');
    if (
      !(await this.db.get('course_bundle_imports', {
        id: this.importId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('Course bundle parent ownership mismatch');
    return super.save(options);
  }
}
export class CourseBundleAudienceChoiceCollection extends SmrtCollection<CourseBundleAudienceChoice> {
  static readonly _itemClass = CourseBundleAudienceChoice;
}

/**
 * Where a unit's section or lesson sits, and whether its position was declared
 * (SMRT #4632). Parts of a split unit that share a key must agree: declared
 * orders must match, a declared and an implicit order conflict, and between
 * implicit positions the part with the lowest index decides, whatever order
 * the parts arrive in. One row per (course, kind, key).
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_bundle_placements',
  conflictColumns: ['tenant_id', 'course_id', 'kind', 'key'],
  indexes: [
    {
      name: 'course_bundle_placements_unique',
      columns: ['tenantId', 'courseId', 'kind', 'key'],
      unique: true,
    },
  ],
  ...closed,
})
export class CourseBundlePlacement extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  /** `section` or `lesson`. */
  kind = 'section';
  key = '';
  title = '';
  /** The manifest's `order`, null when the part left it implicit. */
  @field({ type: 'integer', nullable: true }) declaredOrder: number | null =
    null;
  /** The position in the deciding part, used when no order is declared. */
  implicitOrder = 0;
  /** The part that decided an implicit position (the lowest seen). */
  partIndex = 1;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!this.tenantId?.trim())
      throw new Error('Course bundle evidence requires a tenant');
    if (!['section', 'lesson'].includes(this.kind))
      throw new Error('Invalid placement kind');
    requireText(this.key, 'Placement requires a key', 120);
    requireText(this.title, 'Placement requires a title', 300);
    requireCount(this.implicitOrder, 'Invalid placement order');
    if (this.declaredOrder !== null)
      requireCount(this.declaredOrder, 'Invalid placement order');
    if (!Number.isSafeInteger(this.partIndex) || this.partIndex < 1)
      throw new Error('Invalid bundle part');
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    if (
      prior &&
      (prior.tenant_id !== this.tenantId ||
        prior.course_id !== this.courseId ||
        prior.kind !== this.kind ||
        prior.key !== this.key)
    )
      throw new Error('A placement cannot move');
    if (
      !(await this.db.get('courses', {
        id: this.courseId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('Course bundle parent ownership mismatch');
    return super.save(options);
  }
}
export class CourseBundlePlacementCollection extends SmrtCollection<CourseBundlePlacement> {
  static readonly _itemClass = CourseBundlePlacement;
}

/**
 * The one row every attach of a unit serializes on (SMRT #4632): one per
 * (family, unit key), created if absent and then locked at the start of the
 * attach transaction, before anything that decides the outcome is read. On
 * PostgreSQL a concurrent first create of the same key waits for the other
 * transaction and then adopts its row. Never deleted; nothing else is stored.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_bundle_units',
  conflictColumns: ['tenant_id', 'unit_key'],
  indexes: [
    {
      name: 'course_bundle_units_unique',
      columns: ['tenantId', 'unitKey'],
      unique: true,
    },
  ],
  ...closed,
})
export class CourseBundleUnit extends SmrtObject {
  @tenantId() tenantId = '';
  /** `course.key`, or `bundle:<identity>` for an unnamed bundle. */
  unitKey = '';
  /** The family course the unit's parts attach to (derived, may not exist yet). */
  courseId = '';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!this.tenantId?.trim())
      throw new Error('Course bundle evidence requires a tenant');
    requireText(this.unitKey, 'Unit requires a key', 200);
    requireText(this.courseId, 'Unit requires a course id', 64);
    return super.save(options);
  }
}
export class CourseBundleUnitCollection extends SmrtCollection<CourseBundleUnit> {
  static readonly _itemClass = CourseBundleUnit;
}

/**
 * Append-only audit of a newer build taking over a part of an attached unit
 * (SMRT #4645): which import replaced which, for which course and part, by
 * whom and when. One row per (course, part, superseded import).
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_bundle_supersessions',
  conflictColumns: ['tenant_id', 'superseded_import_id'],
  indexes: [
    {
      name: 'course_bundle_supersessions_old_unique',
      columns: ['tenantId', 'supersededImportId'],
      unique: true,
    },
    {
      name: 'course_bundle_supersessions_new',
      columns: ['tenantId', 'importId'],
    },
  ],
  ...closed,
})
export class CourseBundleSupersession extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  unitKey = '';
  partIndex = 1;
  /** The newer import that now holds the part. */
  @foreignKey('CourseBundleImport', { required: true }) importId = '';
  /** The import it replaced. */
  @foreignKey('CourseBundleImport', { required: true }) supersededImportId = '';
  supersededByUserId = '';
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
    requireText(this.unitKey, 'Supersession requires a unit key', 200);
    requireText(this.supersededByUserId, 'Supersession requires an actor');
    if (!Number.isSafeInteger(this.partIndex) || this.partIndex < 1)
      throw new Error('Invalid bundle part');
    if (this.importId === this.supersededImportId)
      throw new Error('An import cannot supersede itself');
    for (const id of [this.importId, this.supersededImportId])
      if (
        !(await this.db.get('course_bundle_imports', {
          id,
          tenant_id: this.tenantId,
        }))
      )
        throw new Error('Course bundle parent ownership mismatch');
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseBundleSupersessionCollection extends SmrtCollection<CourseBundleSupersession> {
  static readonly _itemClass = CourseBundleSupersession;
}
