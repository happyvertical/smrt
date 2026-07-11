import { crossPackageRef, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { AcquisitionEvent, LeadOptions, LeadStatus } from '../types.js';

function normalizeAcquisitionHistory(raw: string | null | undefined): string {
  if (!raw) {
    return '[]';
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? JSON.stringify(parsed) : '[]';
  } catch {
    return '[]';
  }
}

@TenantScoped({ mode: 'required' })
@smrt({ tableName: 'sales_leads', api: true, cli: true, mcp: true })
export class Lead extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  name: string = '';
  email: string = '';
  organization: string = '';

  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  ownerId: string | null = null;

  status: LeadStatus = 'new';
  qualificationSummary: string = '';
  qualifiedAt: Date | null = null;

  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  qualifiedById: string | null = null;

  acquisitionHistory: string = '[]';
  mergedIntoLeadId: string | null = null;

  constructor(options: LeadOptions = {}) {
    super(options);
    Object.assign(this, options);
    this.acquisitionHistory = normalizeAcquisitionHistory(
      this.acquisitionHistory,
    );
  }

  getAcquisitionHistory(): AcquisitionEvent[] {
    try {
      const value: unknown = JSON.parse(this.acquisitionHistory);
      return Array.isArray(value)
        ? (value as AcquisitionEvent[]).map((event) => ({ ...event }))
        : [];
    } catch {
      return [];
    }
  }

  recordAcquisition(event: AcquisitionEvent): void {
    if (!event.source || !event.occurredAt) {
      throw new Error(
        'Acquisition events require source and occurredAt values',
      );
    }
    this.acquisitionHistory = JSON.stringify([
      ...this.getAcquisitionHistory(),
      { ...event },
    ]);
  }

  assign(ownerId: string): void {
    const normalized = ownerId.trim();
    if (!normalized) {
      throw new Error('A sales representative id is required');
    }
    this.ownerId = normalized;
  }

  qualify(actorId?: string | null, summary?: string): void {
    if (this.status === 'converted' || this.status === 'merged') {
      throw new Error(`A ${this.status} lead cannot be qualified`);
    }
    this.status = 'qualified';
    this.qualifiedAt = new Date();
    this.qualifiedById = actorId?.trim() || null;
    if (summary !== undefined) {
      this.qualificationSummary = summary;
    }
  }

  markConverted(): void {
    this.status = 'converted';
  }

  markMerged(targetLeadId: string): void {
    const normalized = targetLeadId.trim();
    if (!normalized) {
      throw new Error('A merge target lead id is required');
    }
    this.status = 'merged';
    this.mergedIntoLeadId = normalized;
  }
}
