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
    | 'operator-only'
    | 'unverified-license'
    | 'operation-not-permitted';
}

export interface CatalogPolicyOptions {
  /**
   * Tenants (families) designated by the host operator that may see `operator`
   * visibility records. Host configuration, never derived from a request; the
   * default is none, so operator-only records are invisible to everyone.
   */
  operatorTenantIds?: Iterable<string>;
}

/** Server-side resource policy. UI affordances are advisory and cannot bypass it. */
export class CatalogPolicy {
  private readonly operatorTenants: ReadonlySet<string>;
  constructor(options: CatalogPolicyOptions = {}) {
    this.operatorTenants = new Set(
      [...(options.operatorTenantIds ?? [])].filter(
        (id) => typeof id === 'string' && id.trim().length > 0,
      ),
    );
  }

  canView(
    record: Pick<CatalogSourceRecord, 'visibility'>,
    actor: CatalogActor,
  ): boolean {
    if (record.visibility === 'operator')
      return (
        actor.tenantId.trim().length > 0 &&
        this.operatorTenants.has(actor.tenantId)
      );
    return record.visibility === 'catalog' || actor.roles.includes('teacher');
  }

  authorize(
    record: Pick<CatalogSourceRecord, 'visibility' | 'licenseEvidence'>,
    operation: CatalogOperation,
    actor: CatalogActor,
  ): CatalogPolicyDecision {
    if (!this.canView(record, actor))
      return {
        allowed: false,
        reason:
          record.visibility === 'operator'
            ? 'operator-only'
            : 'teacher-material',
      };
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
