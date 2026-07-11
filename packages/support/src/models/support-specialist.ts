/**
 * Support Specialist models (FR-30): the specialist role record layered on a
 * Profile (the `commerce Customer` role-record idiom), per-project
 * qualifications, and availability/on-call windows.
 *
 * - **SupportSpecialist** — a Participant qualified to handle first-tier
 *   support; workload cap, languages, and timezone drive routing.
 * - **SupportQualification** — recognition that a specialist is trained and
 *   approved for a specific app-defined project (effective-dated).
 * - **SupportAvailability** — weekly working windows, on-call spans, and
 *   time-off exceptions used by routing and coverage checks.
 *
 * These are operator configuration surfaces, so they expose generated CRUD.
 */

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
  parseJsonField,
  parseStringArrayField,
  type SupportAvailabilityKind,
  type SupportQualificationLevel,
  type SupportSpecialistStatus,
} from '../types.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_specialists',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: ['tenant_id', 'profile_id'],
})
export class SupportSpecialist extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The Participant (Person profile) this specialist role belongs to. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { required: true })
  profileId: string = '';

  /** Display name for queues/routing rationale (denormalized from Profile). */
  @field({ type: 'text' })
  displayName: string = '';

  @field({ type: 'text' })
  status: SupportSpecialistStatus = 'active';

  /** Languages the specialist supports (JSON array of BCP-47-ish codes). */
  @field({ type: 'text' })
  languages: string = '["en"]';

  /** IANA timezone the weekly availability windows are expressed in. */
  @field({ type: 'text' })
  timezone: string = 'UTC';

  /** Routing workload cap: open cases beyond this exclude the specialist. */
  maxConcurrentCases: number = 10;

  /** Tie-break priority for on-call ranking (higher = preferred). */
  onCallPriority: number = 0;

  @field({ type: 'text' })
  notes: string = '';

  @field({ type: 'text' })
  metadata: string = '{}';

  getLanguages(): string[] {
    return parseStringArrayField(this.languages);
  }

  setLanguages(languages: string[]): void {
    this.languages = JSON.stringify(languages ?? []);
  }

  getMetadata(): Record<string, unknown> {
    return parseJsonField(this.metadata, {});
  }

  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }

  isActive(): boolean {
    return this.status === 'active';
  }
}

export class SupportSpecialistCollection extends SmrtCollection<SupportSpecialist> {
  static readonly _itemClass = SupportSpecialist;

  async findActive(): Promise<SupportSpecialist[]> {
    return this.list({ where: { status: 'active' } });
  }

  async byProfile(profileId: string): Promise<SupportSpecialist | null> {
    const matches = await this.list({ where: { profileId }, limit: 1 });
    return matches[0] ?? null;
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_qualifications',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: ['specialist_id', 'project_id'],
})
export class SupportQualification extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('SupportSpecialist', { required: true })
  specialistId: string = '';

  /** App-defined Project this qualification covers. */
  @field({ type: 'text' })
  projectId: string = '';

  @field({ type: 'text' })
  level: SupportQualificationLevel = 'qualified';

  /** Effective-dating: null bounds mean open-ended. */
  effectiveFrom: Date | null = null;

  effectiveTo: Date | null = null;

  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  grantedByProfileId: string | null = null;

  @field({ type: 'text' })
  notes: string = '';

  /** Whether the qualification is effective at the given instant. */
  isEffectiveAt(at: Date = new Date()): boolean {
    if (this.effectiveFrom && at < this.effectiveFrom) return false;
    if (this.effectiveTo && at >= this.effectiveTo) return false;
    return true;
  }
}

export class SupportQualificationCollection extends SmrtCollection<SupportQualification> {
  static readonly _itemClass = SupportQualification;

  async forSpecialist(specialistId: string): Promise<SupportQualification[]> {
    return this.list({ where: { specialistId } });
  }

  async forProject(projectId: string): Promise<SupportQualification[]> {
    return this.list({ where: { projectId } });
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_availability_windows',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class SupportAvailability extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('SupportSpecialist', { required: true })
  specialistId: string = '';

  @field({ type: 'text' })
  kind: SupportAvailabilityKind = 'weekly';

  /** Weekly windows: 0 = Sunday … 6 = Saturday. Null for span kinds. */
  @field({ type: 'integer', nullable: true })
  weekday: number | null = null;

  /** Weekly windows: minutes from midnight, inclusive start. */
  startMinute: number = 0;

  /** Weekly windows: minutes from midnight, exclusive end. */
  endMinute: number = 0;

  /** Span kinds (`on_call`, `time_off`): absolute start. */
  startsAt: Date | null = null;

  /** Span kinds (`on_call`, `time_off`): absolute end. */
  endsAt: Date | null = null;

  @field({ type: 'text' })
  notes: string = '';
}

export class SupportAvailabilityCollection extends SmrtCollection<SupportAvailability> {
  static readonly _itemClass = SupportAvailability;

  async forSpecialist(specialistId: string): Promise<SupportAvailability[]> {
    return this.list({ where: { specialistId } });
  }
}

export default SupportSpecialist;
