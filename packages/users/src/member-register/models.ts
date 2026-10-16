/** Tenant-scoped legal member-register records. */
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export type LegalMemberKind = 'individual' | 'organisation';
export type LegalMemberStatus = 'active' | 'suspended' | 'resigned' | 'ceased';
export type MemberReferenceKind =
  | 'share'
  | 'dues'
  | 'subscription'
  | 'agreement'
  | 'ledger';

/** A tenant-configured legal class; it has no authority or entitlement effect. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'member_classes',
  sensitive: true,
  indexes: [
    {
      name: 'member_classes_tenant_key_uq',
      columns: ['tenantId', 'key'],
      unique: true,
    },
  ],
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
})
export class MemberClass extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ type: 'text' }) key = '';
  name = '';
  description = '';
  /** Host-defined policy hints only; the register does not interpret law. */
  @field({ type: 'json', nullable: true }) policyMetadata: Record<
    string,
    unknown
  > | null = null;
}

/** The legal register entry, deliberately separate from RBAC Membership. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'legal_members',
  sensitive: true,
  indexes: [
    {
      name: 'legal_members_tenant_class_status_idx',
      columns: ['tenantId', 'memberClassId', 'status'],
    },
    { name: 'legal_members_tenant_user_idx', columns: ['tenantId', 'userId'] },
  ],
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
})
export class LegalMember extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('MemberClass', { onDelete: 'RESTRICT' }) memberClassId = '';
  @field({ type: 'text' }) kind: LegalMemberKind = 'individual';
  displayName = '';
  /** Optional login identity. Its tenant authority is intentionally irrelevant. */
  @foreignKey('User', { nullable: true, onDelete: 'RESTRICT' }) userId:
    | string
    | null = null;
  /** Optional person or organisation profile; an external party needs neither. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  profileId: string | null = null;
  /** A host-owned external-party key, not an inferred identity. */
  @field({ type: 'text', nullable: true }) externalPartyRef: string | null =
    null;
  @field({ type: 'text' }) joinedOn = '';
  @field({ type: 'text', nullable: true }) leftOn: string | null = null;
  @field({ type: 'text' }) status: LegalMemberStatus = 'active';
}

/** Append-only effective history; current status never erases it. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'legal_member_status_history',
  sensitive: true,
  indexes: [
    {
      name: 'legal_member_status_history_member_on_idx',
      columns: ['tenantId', 'memberId', 'effectiveOn'],
    },
  ],
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
})
export class LegalMemberStatusHistory extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('LegalMember', { onDelete: 'RESTRICT' }) memberId = '';
  @field({ type: 'text' }) status: LegalMemberStatus = 'active';
  @field({ type: 'text' }) effectiveOn = '';
  /** Stable correction order for entries sharing an effective date. */
  @field({ type: 'integer' }) sequence = 0;
  reason = '';
  @field({ type: 'text', nullable: true }) actorRef: string | null = null;
  /** History is corrected by appending another effective entry, never rewriting it. */
  override async save(): Promise<this> {
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Legal member status history is append-only.');
    this.requireInsertOnSave();
    return super.save();
  }
  override async delete(): Promise<void> {
    throw new Error('Legal member status history cannot be deleted.');
  }
}

/** A link to authoritative share/dues/subscription/agreement/ledger evidence. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'legal_member_references',
  sensitive: true,
  indexes: [
    {
      name: 'legal_member_references_member_kind_idx',
      columns: ['tenantId', 'memberId', 'kind'],
    },
  ],
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
})
export class LegalMemberReference extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('LegalMember', { onDelete: 'RESTRICT' }) memberId = '';
  @field({ type: 'text' }) kind: MemberReferenceKind = 'share';
  /** Qualified external model name or host namespace, e.g. @happyvertical/smrt-ledgers:JournalEntry. */
  sourceType = '';
  sourceId = '';
  /** Whether a caller supplied authoritative evidence; no balance is duplicated here. */
  @field({ type: 'boolean' }) authoritative = false;
  /** The date on which this evidence may first support a record-date decision. */
  @field({ type: 'text' }) effectiveFrom = '';
  @field({ type: 'text', nullable: true }) effectiveTo: string | null = null;
  /** Original evidence withdrawn by this append-only dated record. */
  @foreignKey('LegalMemberReference', { nullable: true, onDelete: 'RESTRICT' })
  revokesId: string | null = null;
  override async save(): Promise<this> {
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Legal member references are append-only.');
    this.requireInsertOnSave();
    return super.save();
  }
  override async delete(): Promise<void> {
    throw new Error('Legal member references cannot be deleted.');
  }
}

/** A dated register of board/officer appointments; it does not implement elections. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'member_officer_appointments',
  sensitive: true,
  indexes: [
    {
      name: 'member_officer_appointments_member_term_idx',
      columns: ['tenantId', 'memberId', 'effectiveFrom'],
    },
  ],
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
})
export class MemberOfficerAppointment extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('LegalMember', { onDelete: 'RESTRICT' }) memberId = '';
  @field({ type: 'text' }) role = '';
  @field({ type: 'text' }) effectiveFrom = '';
  @field({ type: 'text', nullable: true }) effectiveTo: string | null = null;
  /** Host-defined authority descriptors; this is not an RBAC grant. */
  @field({ type: 'json', nullable: true }) authority: Record<
    string,
    unknown
  > | null = null;
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'member_eligibility_snapshots',
  sensitive: true,
  indexes: [
    {
      name: 'member_eligibility_snapshots_tenant_date_idx',
      columns: ['tenantId', 'recordDate'],
    },
  ],
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
})
export class MemberEligibilitySnapshot extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('LegalMember', { onDelete: 'RESTRICT' }) memberId = '';
  @field({ type: 'text' }) recordDate = '';
  @field({ type: 'boolean' }) eligible = false;
  reason = '';
  /** Preserves inputs, including unavailable evidence, for a neutral export. */
  @field({ type: 'json', nullable: true }) evidence: Record<
    string,
    unknown
  > | null = null;
  /** Record-date evidence is immutable; a later request creates a new snapshot. */
  override async save(): Promise<this> {
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Member eligibility snapshots are immutable.');
    this.requireInsertOnSave();
    return super.save();
  }
  override async delete(): Promise<void> {
    throw new Error('Member eligibility snapshots cannot be deleted.');
  }
}

@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class MemberClassCollection extends SmrtCollection<MemberClass> {
  static readonly _itemClass = MemberClass;
}
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class LegalMemberCollection extends SmrtCollection<LegalMember> {
  static readonly _itemClass = LegalMember;
}
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class LegalMemberStatusHistoryCollection extends SmrtCollection<LegalMemberStatusHistory> {
  static readonly _itemClass = LegalMemberStatusHistory;
}
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class LegalMemberReferenceCollection extends SmrtCollection<LegalMemberReference> {
  static readonly _itemClass = LegalMemberReference;
}
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class MemberOfficerAppointmentCollection extends SmrtCollection<MemberOfficerAppointment> {
  static readonly _itemClass = MemberOfficerAppointment;
}
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class MemberEligibilitySnapshotCollection extends SmrtCollection<MemberEligibilitySnapshot> {
  static readonly _itemClass = MemberEligibilitySnapshot;
}
