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
  type EmploymentChangeKind,
  type EmploymentStatus,
  HrError,
  type IsoDate,
  type WorkerType,
} from '../types.js';
import { assertHrWrite, hasHrWrite } from '../write.js';

/** Stored column and model property of each employment column this package owns. */
const PACKAGE_OWNED_COLUMNS = [
  ['tenant_id', 'tenantId'],
  ['profile_id', 'profileId'],
  ['user_id', 'userId'],
  ['employer_profile_id', 'employerProfileId'],
  ['employee_number', 'employeeNumber'],
  ['worker_type', 'workerType'],
  ['position', 'position'],
  ['status', 'status'],
] as const;

/**
 * One person's employment with a tenant: the stable record applications and
 * payroll key on. There is one per tenant and profile; a rehire adds an
 * {@link EmploymentTerm} to the same row. The tenant is the employer.
 *
 * Applications extend it with a same-named subclass over the `employments`
 * table that restates the closed surface (see AGENTS.md). Such a subclass may
 * `save()` its own added fields on an existing row; the columns this package
 * owns change only through `EmploymentService`.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'employments',
  sensitive: true,
  conflictColumns: ['tenant_id', 'employee_number'],
  indexes: [
    {
      name: 'employments_tenant_profile_uq',
      columns: ['tenantId', 'profileId'],
      unique: true,
    },
    { name: 'employments_tenant_user_idx', columns: ['tenantId', 'userId'] },
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class Employment extends SmrtObject {
  @tenantId() tenantId = '';
  /** The person employed. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    onDelete: 'RESTRICT',
  })
  profileId = '';
  /** Optional login; a worker signing in on a shared device may have none. */
  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  userId: string | null = null;
  /** Optional organization profile when it differs from the tenant itself. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  employerProfileId: string | null = null;
  /** Free text, unique per tenant. */
  employeeNumber = '';
  @field({ type: 'text' }) workerType: WorkerType = 'employee';
  /** Position or trade label; latest recorded value. */
  @field({ type: 'text', nullable: true }) position: string | null = null;
  @field({ type: 'text' }) status: EmploymentStatus = 'active';

  override async save(): Promise<this> {
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    // Without the service's write capability only an application subclass's
    // own fields may change: the row must exist and every package-owned
    // column must still hold its stored value.
    if (
      !hasHrWrite(this) &&
      (!prior ||
        PACKAGE_OWNED_COLUMNS.some(
          ([column, property]) =>
            (prior[column] ?? null) !== (this[property] ?? null),
        ))
    )
      throw new HrError(
        'HR_WRITE_FORBIDDEN',
        'Employment columns owned by the HR package are writable only through EmploymentService.',
      );
    if (
      prior &&
      (prior.tenant_id !== this.tenantId || prior.profile_id !== this.profileId)
    )
      throw new HrError(
        'HR_HISTORY_IMMUTABLE',
        'Employment identity is immutable.',
      );
    return (await super.save()) as this;
  }
  override async delete(): Promise<void> {
    throw new HrError(
      'HR_HISTORY_IMMUTABLE',
      'Employment history cannot be deleted; end the employment instead.',
    );
  }
}

/**
 * One continuous period of employment. `endedOn` is the last day employed
 * (inclusive); null means the term is open. "Employed on a date" is answered
 * from terms, never from {@link Employment.status}.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'employment_terms',
  sensitive: true,
  indexes: [
    {
      name: 'employment_terms_employment_idx',
      columns: ['tenantId', 'employmentId', 'startedOn'],
    },
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class EmploymentTerm extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Employment', { onDelete: 'RESTRICT' }) employmentId = '';
  @field({ type: 'text' }) startedOn: IsoDate = '';
  @field({ type: 'text', nullable: true }) endedOn: IsoDate | null = null;
  endReason = '';

  override async save(): Promise<this> {
    assertHrWrite(this);
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    if (
      prior &&
      (prior.ended_on != null ||
        prior.employment_id !== this.employmentId ||
        prior.started_on !== this.startedOn)
    )
      throw new HrError(
        'HR_HISTORY_IMMUTABLE',
        'A term can only be closed once; its start and employment never change.',
      );
    return (await super.save()) as this;
  }
  override async delete(): Promise<void> {
    throw new HrError(
      'HR_HISTORY_IMMUTABLE',
      'Employment terms cannot be deleted.',
    );
  }
}

/** Append-only dated change to an employment, attributed to an actor. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'employment_changes',
  sensitive: true,
  indexes: [
    {
      name: 'employment_changes_employment_idx',
      columns: ['tenantId', 'employmentId', 'effectiveOn'],
    },
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class EmploymentChange extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Employment', { onDelete: 'RESTRICT' }) employmentId = '';
  @field({ type: 'text' }) kind: EmploymentChangeKind = 'hired';
  @field({ type: 'text' }) effectiveOn: IsoDate = '';
  @field({ type: 'text', nullable: true }) fromValue: string | null = null;
  @field({ type: 'text', nullable: true }) toValue: string | null = null;
  note = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    onDelete: 'RESTRICT',
  })
  actorProfileId = '';

  override async save(): Promise<this> {
    assertHrWrite(this);
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new HrError(
        'HR_HISTORY_IMMUTABLE',
        'Employment changes are append-only.',
      );
    this.requireInsertOnSave();
    return (await super.save()) as this;
  }
  override async delete(): Promise<void> {
    throw new HrError(
      'HR_HISTORY_IMMUTABLE',
      'Employment changes cannot be deleted.',
    );
  }
}

/**
 * Scoped persistence collection; mutations must use EmploymentService.
 * Collections are registered too, so each restates the closed surface: an
 * undecorated one would publish its methods as generated tools.
 */
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class EmploymentCollection extends SmrtCollection<Employment> {
  static readonly _itemClass = Employment;
}
/** Scoped term collection; closed like its model. */
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class EmploymentTermCollection extends SmrtCollection<EmploymentTerm> {
  static readonly _itemClass = EmploymentTerm;
}
/** Scoped append-only change collection; closed like its model. */
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class EmploymentChangeCollection extends SmrtCollection<EmploymentChange> {
  static readonly _itemClass = EmploymentChange;
}
