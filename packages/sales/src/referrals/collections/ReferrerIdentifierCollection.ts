import {
  isUniqueViolationError,
  SmrtCollection,
} from '@happyvertical/smrt-core';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { ReferrerIdentifier } from '../models/ReferrerIdentifier.js';
import { normalizeIdentifier } from '../nomination-identity.js';
import { ReferralProgramCollection } from './ReferralProgramCollection.js';
import { ReferrerCollection } from './ReferrerCollection.js';

export interface RegisterReferrerIdentifierInput {
  tenantId: string | null;
  referrerId: string;
  programId?: string | null;
  kind: string;
  value: string;
  metadata?: Record<string, unknown>;
}

/** An alias stays reserved to its original owner after it is disabled. */
export class ReferrerIdentifierConflictError extends Error {
  constructor(cause?: unknown) {
    super('ReferrerIdentifier is already registered in this tenant', { cause });
    this.name = 'ReferrerIdentifierConflictError';
  }
}

export class ReferrerIdentifierCollection extends SmrtCollection<ReferrerIdentifier> {
  static readonly _itemClass = ReferrerIdentifier;

  /** Register an alias in the caller's executor and tenant lane. */
  async register(
    input: RegisterReferrerIdentifierInput,
  ): Promise<ReferrerIdentifier> {
    const contextTenantId = getTenantId();
    if (contextTenantId && contextTenantId !== input.tenantId) {
      throw new Error('ReferrerIdentifier registration tenant mismatch');
    }
    const options = {
      db: this.db,
      _reuseInitializedDb: true,
      _deferRuntimeInitialization: true,
    };
    const referrers = await ReferrerCollection.create(options);
    const referrer = await referrers.get({ id: input.referrerId });
    if (!referrer || referrer.tenantId !== input.tenantId) {
      throw new Error(
        'ReferrerIdentifier requires a referrer in the same tenant',
      );
    }
    if (input.programId) {
      const programs = await ReferralProgramCollection.create(options);
      const program = await programs.get({ id: input.programId });
      if (!program || program.tenantId !== input.tenantId) {
        throw new Error(
          'ReferrerIdentifier requires a program in the same tenant',
        );
      }
    }

    const programId = input.programId ?? null;
    const kind = normalizeIdentifier(input.kind);
    const existing = await this.findOne({
      where: {
        tenantId: input.tenantId,
        kind,
        normalizedValue: normalizeIdentifier(input.value),
      },
    });
    if (existing) {
      if (
        existing.isActive() &&
        existing.referrerId === input.referrerId &&
        existing.programId === programId
      ) {
        return existing;
      }
      throw new ReferrerIdentifierConflictError();
    }
    try {
      return await this.create({
        tenantId: input.tenantId,
        referrerId: input.referrerId,
        programId,
        kind,
        value: input.value,
        metadata: JSON.stringify(input.metadata ?? {}),
      });
    } catch (error) {
      if (isUniqueViolationError(error)) {
        throw new ReferrerIdentifierConflictError(error);
      }
      throw error;
    }
  }
}
