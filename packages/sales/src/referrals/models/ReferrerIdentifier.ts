import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getTenantId,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import { nominationUuid, normalizeIdentifier } from '../nomination-identity.js';
import type {
  ReferrerIdentifierOptions,
  ReferrerIdentifierStatus,
} from '../types.js';

/** A tenant's verified spelling, code, address, or other alias for a referrer. */
@TenantScoped({ mode: 'optional' })
@smrt({
  conflictColumns: ['tenant_id', 'kind', 'normalized_value'],
  sensitive: true,
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: false,
})
export class ReferrerIdentifier extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('Referrer', { required: true, requiredFor: 'identity' })
  referrerId: string = '';

  @foreignKey('ReferralProgram')
  programId: string | null = null;

  /** Open vocabulary, for example email, code, name, or handle. */
  @field({ required: true, requiredFor: 'identity' })
  kind: string = '';

  /** Original spelling as registered by the host. */
  @field({ required: true, requiredFor: 'identity' })
  value: string = '';

  /** Derived with Unicode compatibility normalization and case folding. */
  @field({ required: true, requiredFor: 'identity' })
  normalizedValue: string = '';

  status: ReferrerIdentifierStatus = 'active';

  metadata: string = '{}';

  constructor(options: ReferrerIdentifierOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.referrerId !== undefined) this.referrerId = options.referrerId;
    if (options.programId !== undefined) this.programId = options.programId;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.value !== undefined) this.value = options.value;
    if (options.status !== undefined) this.status = options.status;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  disable(): void {
    this.status = 'disabled';
  }

  getMetadata(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(this.metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = JSON.stringify(metadata);
  }

  override async save(options?: SmrtSaveOptions): Promise<this> {
    const contextTenantId = getTenantId();
    this.tenantId ??= contextTenantId ?? null;
    if (contextTenantId && this.tenantId !== contextTenantId) {
      throw new Error('ReferrerIdentifier belongs to a different tenant');
    }
    this.kind = normalizeIdentifier(this.kind);
    this.normalizedValue = normalizeIdentifier(this.value);
    if (
      !this.kind ||
      !this.normalizedValue ||
      !this.referrerId ||
      !['active', 'disabled'].includes(this.status)
    ) {
      throw new Error(
        'ReferrerIdentifier requires a referrer, kind, value, and valid status',
      );
    }

    if (this.isPersisted) {
      const stored = await this.db.get(this.tableName, { id: this.id });
      if (
        !stored ||
        (stored.tenant_id ?? null) !== this.tenantId ||
        stored.referrer_id !== this.referrerId ||
        (stored.program_id ?? null) !== this.programId ||
        stored.kind !== this.kind ||
        stored.value !== this.value ||
        stored.normalized_value !== this.normalizedValue ||
        stored.metadata !== this.metadata ||
        (stored.status === 'disabled' && this.status !== 'disabled')
      ) {
        throw new Error(
          'ReferrerIdentifier is append-only and may only be disabled',
        );
      }
    } else {
      // NULL tenant values do not collide in SQL composite unique indexes.
      // The deterministic primary key enforces uniqueness in that lane too.
      this.id = nominationUuid([
        'referrer-identifier',
        this.tenantId,
        this.kind,
        this.normalizedValue,
      ]);
      this.requireInsertOnSave();
    }
    return await super.save(options);
  }

  override async delete(): Promise<void> {
    throw new Error(
      'ReferrerIdentifier is append-only and may only be disabled',
    );
  }
}
