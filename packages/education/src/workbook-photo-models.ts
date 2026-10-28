import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

const closed = { api: false, mcp: false, cli: false } as const;
/** Concrete models declare their persisted ownership fields: the manifest scanner
 * does not merge fields from a custom abstract base into independent tables. */
async function assertPhotoHistory(
  row: SmrtObject & { tenantId: string; learnerId: string },
): Promise<void> {
  if (
    !row.tenantId ||
    !(await row.db.get('learners', {
      id: row.learnerId,
      tenant_id: row.tenantId,
    }))
  )
    throw new Error('Photo intake parent ownership mismatch');
  if (row.id && (await row.db.get(row.tableName, { id: row.id })))
    throw new Error('Photo intake history is immutable');
}
function denyHistoryDeletion(): never {
  throw new Error(
    'Photo intake history requires an owning retention operation',
  );
}
/** Durable receipt before any course, enrollment or activity exists. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_photo_intakes',
  conflictColumns: ['tenant_id', 'item_id'],
  ...closed,
})
export class WorkbookPhotoIntake extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  override async delete(): Promise<void> {
    denyHistoryDeletion();
  }
  itemId = '';
  actorUserId = '';
  contentDigest = '';
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await assertPhotoHistory(this);
    return super.save(options);
  }
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    Object.assign(
      this,
      Object.fromEntries(
        Object.entries(options).filter(([key]) => Object.hasOwn(this, key)),
      ),
    );
  }
}
export class WorkbookPhotoIntakeCollection extends SmrtCollection<WorkbookPhotoIntake> {
  static readonly _itemClass = WorkbookPhotoIntake;
}
/** Sole owner join for original photo intake files. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_photo_assets',
  conflictColumns: ['tenant_id', 'intake_id', 'asset_id'],
  ...closed,
})
export class WorkbookPhotoAsset extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  override async delete(): Promise<void> {
    denyHistoryDeletion();
  }
  @foreignKey('WorkbookPhotoIntake', { required: true }) intakeId = '';
  @crossPackageRef('@happyvertical/smrt-assets:Asset') assetId = '';
  name = '';
  mimeType = '';
  sha256 = '';
  position = 0;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    Object.assign(
      this,
      Object.fromEntries(
        Object.entries(options).filter(([key]) => Object.hasOwn(this, key)),
      ),
    );
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await assertPhotoHistory(this);
    if (
      !(await this.db.get('workbook_photo_intakes', {
        id: this.intakeId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Photo original ownership mismatch');
    const learner = await this.db.get('learners', {
      id: this.learnerId,
      tenant_id: this.tenantId,
    });
    if (
      !learner ||
      !(await this.db.get('assets', {
        id: this.assetId,
        tenant_id: this.tenantId,
        owner_profile_id: learner.profile_id,
        access_mode: 'private',
      }))
    )
      throw new Error('Photo original must be an owned private asset');
    return super.save(options);
  }
}
export class WorkbookPhotoAssetCollection extends SmrtCollection<WorkbookPhotoAsset> {
  static readonly _itemClass = WorkbookPhotoAsset;
}
/** Immutable provider/guardian/capture decision, retaining provenance and retry key. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_photo_decisions',
  conflictColumns: ['tenant_id', 'intake_id', 'request_key'],
  ...closed,
})
export class WorkbookPhotoDecision extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  override async delete(): Promise<void> {
    denyHistoryDeletion();
  }
  @foreignKey('WorkbookPhotoIntake', { required: true }) intakeId = '';
  requestKey = '';
  sequence = 0;
  actorUserId = '';
  @field({ type: 'text' }) bodyJson = '{}';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    Object.assign(
      this,
      Object.fromEntries(
        Object.entries(options).filter(([key]) => Object.hasOwn(this, key)),
      ),
    );
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await assertPhotoHistory(this);
    if (
      !(await this.db.get('workbook_photo_intakes', {
        id: this.intakeId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Photo decision ownership mismatch');
    return super.save(options);
  }
}
export class WorkbookPhotoDecisionCollection extends SmrtCollection<WorkbookPhotoDecision> {
  static readonly _itemClass = WorkbookPhotoDecision;
}
/** Versioned contextual metadata; never edits Workbook identity or learning evidence. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_context_revisions',
  conflictColumns: ['tenant_id', 'decision_id'],
  ...closed,
})
export class WorkbookContextRevision extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  override async delete(): Promise<void> {
    denyHistoryDeletion();
  }
  @foreignKey('Workbook', { required: true }) workbookId = '';
  @foreignKey('WorkbookPhotoDecision', { required: true }) decisionId = '';
  @field({ type: 'text' }) metadataJson = '{}';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    Object.assign(
      this,
      Object.fromEntries(
        Object.entries(options).filter(([key]) => Object.hasOwn(this, key)),
      ),
    );
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await assertPhotoHistory(this);
    if (
      !(await this.db.get('workbooks', {
        id: this.workbookId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Workbook context ownership mismatch');
    if (
      !(await this.db.get('workbook_photo_decisions', {
        id: this.decisionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Workbook context decision ownership mismatch');
    return super.save(options);
  }
}
export class WorkbookContextRevisionCollection extends SmrtCollection<WorkbookContextRevision> {
  static readonly _itemClass = WorkbookContextRevision;
}
