import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  type HeldQualificationChangeKind,
  type HeldQualificationStatus,
  HrError,
  type IsoDate,
  type QualificationKind,
  type QualificationScope,
} from '../types.js';
import { assertHrWrite } from '../write.js';

/**
 * A qualification definition: a managed list per tenant. Other packages gate
 * work by referencing its id (`@happyvertical/smrt-human-resources:Qualification`).
 * Not a permission: who may use the software stays with smrt-users.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'qualifications',
  sensitive: true,
  conflictColumns: ['tenant_id', 'key'],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class Qualification extends SmrtObject {
  @tenantId() tenantId = '';
  /** Lowercase kebab-case, unique per tenant: `first-aid`. */
  key = '';
  name = '';
  @field({ type: 'text' }) kind: QualificationKind = 'certification';
  issuingBody = '';
  /** Whether held qualifications of this kind expire. */
  expires = false;
  /** Default validity in months, applied when a grant gives no expiry. */
  @field({ type: 'integer', nullable: true })
  validityMonths: number | null = null;
  /** Whether a held qualification belongs to the person or the employment. */
  @field({ type: 'text' }) scope: QualificationScope = 'person';
  isActive = true;

  override async save(): Promise<this> {
    assertHrWrite(this);
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    if (prior && (prior.key !== this.key || prior.scope !== this.scope))
      throw new HrError(
        'HR_HISTORY_IMMUTABLE',
        'A qualification key and scope are immutable; deactivate it instead.',
      );
    return (await super.save()) as this;
  }
  override async delete(): Promise<void> {
    throw new HrError(
      'HR_HISTORY_IMMUTABLE',
      'Qualifications cannot be deleted; deactivate them instead.',
    );
  }
}

/**
 * A person holds a qualification. `employmentId` is set when the definition's
 * scope is `employment`; such a row is revoked when that employment ends.
 * A renewal is a new row pointing at the one it renews, so past dates still
 * answer correctly. Expiry on a date is computed from `expiresOn`; the stored
 * `expired` status is set by the service sweep.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'held_qualifications',
  sensitive: true,
  indexes: [
    {
      name: 'held_qualifications_profile_idx',
      columns: ['tenantId', 'profileId', 'qualificationId'],
    },
    {
      name: 'held_qualifications_expiry_idx',
      columns: ['tenantId', 'status', 'expiresOn'],
    },
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class HeldQualification extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey(Qualification, { onDelete: 'RESTRICT' }) qualificationId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    onDelete: 'RESTRICT',
  })
  profileId = '';
  @foreignKey('Employment', { nullable: true, onDelete: 'RESTRICT' })
  employmentId: string | null = null;
  @field({ type: 'text' }) issuedOn: IsoDate = '';
  @field({ type: 'text', nullable: true }) expiresOn: IsoDate | null = null;
  certificateNumber = '';
  @field({ type: 'text' }) status: HeldQualificationStatus = 'valid';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  verifiedByProfileId: string | null = null;
  verifiedAt: Date | null = null;
  @crossPackageRef('@happyvertical/smrt-assets:Asset', { nullable: true })
  documentAssetId: string | null = null;
  @foreignKey('HeldQualification', { nullable: true, onDelete: 'RESTRICT' })
  renewalOfId: string | null = null;

  override async save(): Promise<this> {
    assertHrWrite(this);
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    if (
      prior &&
      (prior.tenant_id !== this.tenantId ||
        prior.profile_id !== this.profileId ||
        prior.qualification_id !== this.qualificationId ||
        prior.issued_on !== this.issuedOn)
    )
      throw new HrError(
        'HR_HISTORY_IMMUTABLE',
        'A held qualification keeps its person, qualification and issue date; renew it instead.',
      );
    if (prior?.status === 'revoked')
      throw new HrError(
        'HR_HISTORY_IMMUTABLE',
        'A revoked qualification never changes; grant a new one.',
      );
    return (await super.save()) as this;
  }
  override async delete(): Promise<void> {
    throw new HrError(
      'HR_HISTORY_IMMUTABLE',
      'Held qualifications cannot be deleted; revoke them instead.',
    );
  }
}

/** Append-only dated change to a held qualification, attributed to an actor. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'held_qualification_changes',
  sensitive: true,
  indexes: [
    {
      name: 'held_qualification_changes_held_idx',
      columns: ['tenantId', 'heldQualificationId', 'effectiveOn'],
    },
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class HeldQualificationChange extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey(HeldQualification, { onDelete: 'RESTRICT' })
  heldQualificationId = '';
  @field({ type: 'text' }) kind: HeldQualificationChangeKind = 'granted';
  @field({ type: 'text' }) effectiveOn: IsoDate = '';
  reason = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    onDelete: 'RESTRICT',
  })
  actorProfileId = '';

  override async save(): Promise<this> {
    assertHrWrite(this);
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new HrError(
        'HR_HISTORY_IMMUTABLE',
        'Held qualification changes are append-only.',
      );
    this.requireInsertOnSave();
    return (await super.save()) as this;
  }
  override async delete(): Promise<void> {
    throw new HrError(
      'HR_HISTORY_IMMUTABLE',
      'Held qualification changes cannot be deleted.',
    );
  }
}

/**
 * Scoped definition collection; mutations must use QualificationService.
 * Collections are registered too, so each restates the closed surface: an
 * undecorated one would publish its methods as generated tools.
 */
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class QualificationCollection extends SmrtCollection<Qualification> {
  static readonly _itemClass = Qualification;
}
/** Scoped held-qualification collection; closed like its model. */
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class HeldQualificationCollection extends SmrtCollection<HeldQualification> {
  static readonly _itemClass = HeldQualification;
}
/** Scoped append-only change collection; closed like its model. */
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class HeldQualificationChangeCollection extends SmrtCollection<HeldQualificationChange> {
  static readonly _itemClass = HeldQualificationChange;
}
