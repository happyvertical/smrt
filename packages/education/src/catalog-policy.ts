import type {
  CatalogActor,
  CatalogLicenseEvidence,
  CatalogOperation,
  CatalogSourceRecord,
} from './catalog-contracts.js';

export interface CatalogPolicyDecision {
  allowed: boolean;
  reason?:
    | 'teacher-material'
    | 'unverified-license'
    | 'operation-not-permitted';
}

/** Server-side resource policy. UI affordances are advisory and cannot bypass it. */
export class CatalogPolicy {
  canView(
    record: Pick<CatalogSourceRecord, 'visibility'>,
    actor: CatalogActor,
  ): boolean {
    return record.visibility === 'catalog' || actor.roles.includes('teacher');
  }

  authorize(
    record: Pick<CatalogSourceRecord, 'visibility' | 'licenseEvidence'>,
    operation: CatalogOperation,
    actor: CatalogActor,
  ): CatalogPolicyDecision {
    if (!this.canView(record, actor))
      return { allowed: false, reason: 'teacher-material' };
    const evidence = record.licenseEvidence;
    if (!this.isVerified(evidence))
      return { allowed: false, reason: 'unverified-license' };
    if (!evidence.permittedOperations?.includes(operation))
      return { allowed: false, reason: 'operation-not-permitted' };
    return { allowed: true };
  }

  private isVerified(evidence: CatalogLicenseEvidence): boolean {
    return evidence.state === 'verified' && !!evidence.identifier?.trim();
  }
}
