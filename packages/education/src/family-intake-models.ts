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
import type { DatabaseInterface } from '@happyvertical/sql';

const closed = { api: false, mcp: false, cli: false } as const;
async function immutable(row: SmrtObject & { tenantId: string }) {
  if (
    !row.tenantId ||
    (row.id && (await row.db.get(row.tableName, { id: row.id })))
  )
    throw new Error('Family intake history is immutable');
}
function noDelete(): never {
  throw new Error('Family originals require an owning retention operation');
}
/** Family-owned receipt, independent of learner attribution and ingestion expiry. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'family_intakes',
  conflictColumns: ['tenant_id', 'item_id'],
  ...closed,
})
export class FamilyIntake extends SmrtObject {
  @tenantId() tenantId = '';
  itemId = '';
  actorUserId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile') ownerProfileId = '';
  contentDigest = '';
  @field({ type: 'text' }) sourceJson = '{}';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    Object.assign(
      this,
      Object.fromEntries(
        Object.entries(options).filter(([k]) => Object.hasOwn(this, k)),
      ),
    );
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await immutable(this);
    return super.save(options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
}
export class FamilyIntakeCollection extends SmrtCollection<FamilyIntake> {
  static readonly _itemClass = FamilyIntake;
}
/** Sole family owner join; adoption borrows this exact immutable original. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'family_intake_assets',
  conflictColumns: ['tenant_id', 'intake_id', 'asset_id'],
  ...closed,
})
export class FamilyIntakeAsset extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('FamilyIntake', { required: true }) intakeId = '';
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
        Object.entries(options).filter(([k]) => Object.hasOwn(this, k)),
      ),
    );
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await immutable(this);
    const parent = await this.db.get('family_intakes', {
      id: this.intakeId,
      tenant_id: this.tenantId,
    });
    if (
      !parent ||
      !(await this.db.get('assets', {
        id: this.assetId,
        tenant_id: this.tenantId,
        owner_profile_id: parent.owner_profile_id,
        access_mode: 'private',
      }))
    )
      throw new Error('Family original ownership mismatch');
    return super.save(options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
}
export class FamilyIntakeAssetCollection extends SmrtCollection<FamilyIntakeAsset> {
  static readonly _itemClass = FamilyIntakeAsset;
}
/** Append-only attribution/adoption audit; no marks or learning outcomes. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'family_intake_decisions',
  conflictColumns: ['tenant_id', 'intake_id', 'request_key'],
  ...closed,
})
export class FamilyIntakeDecision extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('FamilyIntake', { required: true }) intakeId = '';
  requestKey = '';
  sequence = 0;
  actorUserId = '';
  @field({ type: 'text' }) bodyJson = '{}';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    Object.assign(
      this,
      Object.fromEntries(
        Object.entries(options).filter(([k]) => Object.hasOwn(this, k)),
      ),
    );
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await immutable(this);
    if (
      !(await this.db.get('family_intakes', {
        id: this.intakeId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('Family decision ownership mismatch');
    return super.save(options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
}
export class FamilyIntakeDecisionCollection extends SmrtCollection<FamilyIntakeDecision> {
  static readonly _itemClass = FamilyIntakeDecision;
}

/** Package-internal proof for the sole family-to-learner borrowing boundary. */
export async function familyAdoptionOwner(
  db: DatabaseInterface,
  photo: {
    id: string;
    tenant_id: string;
    learner_id: string;
    item_id: string;
    family_intake_id: string;
    actor_user_id: string;
  },
): Promise<string> {
  const family = await db.get('family_intakes', {
    id: photo.family_intake_id,
    tenant_id: photo.tenant_id,
    item_id: photo.item_id,
    actor_user_id: photo.actor_user_id,
  });
  if (!family) throw new Error('Family adoption receipt mismatch');
  const decisions = await db.query(
    'SELECT body_json FROM family_intake_decisions WHERE tenant_id=? AND intake_id=?',
    [photo.tenant_id, photo.family_intake_id],
  );
  if (
    !decisions.rows.some((row) => {
      const body = JSON.parse(String(row.body_json));
      return (
        body.kind === 'adopt' &&
        body.learnerId === photo.learner_id &&
        body.photoIntakeId === photo.id
      );
    })
  )
    throw new Error('Family adoption decision mismatch');
  return String(family.owner_profile_id);
}
